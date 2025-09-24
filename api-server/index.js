const express = require("express");
const fs = require("fs");
const path = require("path");
const { generateSlug } = require("random-word-slugs");
const { ECSClient, RunTaskCommand } = require("@aws-sdk/client-ecs");

const { Server } = require("socket.io");
const cors = require("cors");

const { z } = require("zod");

const { PrismaClient } = require("./generated/prisma");
const prisma = new PrismaClient({});
const { createClient } = require("@clickhouse/client");
const { v4: uuidv4 } = require("uuid");

const client = createClient({
  host: "",
  database: "",
  username: "",
  password: "",
});

const { Kafka } = require("kafkajs");
const { he } = require("zod/v4/locales");
const kafka = new Kafka({
  clientId: ``,
  brokers: [""],
  ssl: {
    ca: [fs.readFileSync(path.join(__dirname, ""), "utf-8")],
  },
  sasl: {
    username: "",
    password: "",
    mechanism: "",
  },
});

const consumer = kafka.consumer({ groupId: `api-server-logs-consumer` });

const app = express();
const PORT = 9000;

const ecsClient = new ECSClient({
  region: "us-east-1",
  credentials: {
    accessKeyId: "",
    secretAccessKey: "",
  },
});

const config = {
  CLUSTER: "",
  TASK: "",
};

app.use(express.json());
app.use(cors());

app.post("/project", async (req, res) => {
  const schema = z.object({
    name: z.string(),
    gitURL: z.string(),
  });

  console.log(req.body);

  const safeParseResult = schema.safeParse(req.body);

  if (safeParseResult.error) {
    return res.status(400).json({ error: safeParseResult.error });
  }

  console.log("data", safeParseResult.data);

  const { name, gitURL } = safeParseResult.data;

  const project = await prisma.project.create({
    data: {
      name,
      gitURL,
      subDomain: generateSlug(),
    },
  });

  return res.json({ status: "success", data: project });
});

app.post("/deploy", async (req, res) => {
  const { projectId } = req.body;
  const project = await prisma.project.findUnique({
    where: { id: projectId },
  });

  if (!project) {
    return res.status(404).json({ error: "Project not found" });
  }

  const deployment = await prisma.deployment.create({
    data: {
      project: { connect: { id: projectId } },
      status: "QUEUED",
    },
  });

  //spin the container
  const command = new RunTaskCommand({
    cluster: config.CLUSTER,
    taskDefinition: config.TASK,
    launchType: "FARGATE",
    count: 1,
    networkConfiguration: {
      awsvpcConfiguration: {
        assignPublicIp: "ENABLED",
        subnets: [
          "subnet-0771cc68752a76b7e",
          "subnet-08161890ea433ec9e",
          "subnet-0180f8e949fd88e3c",
          "subnet-029ce705811f490de",
          "subnet-02ce2c255c45bbbe0",
          "subnet-0d0a84a6233ffed26",
        ],
        securityGroups: ["sg-0113ad501c778175d"],
      },
    },
    overrides: {
      containerOverrides: [
        {
          name: "vercel-builder-image",
          environment: [
            { name: "GIT_REPOSITORY__URL", value: project.gitURL },
            { name: "PROJECT_ID", value: project.id },
            { name: "DEPLOYMENT_ID", value: deployment.id },
          ],
        },
      ],
    },
  });

  await ecsClient.send(command);

  return res.json({
    status: "queued",
    data: { deploymentId: deployment.id },
  });
});

app.listen(PORT, () => console.log(`API Server Running..${PORT}`));

const io = new Server({ cors: "*" });
io.on("connection", (socket) => {
  socket.on("subscribe", (channel) => {
    socket.join(channel);
    socket.emit("message", `Joined channel ${channel}`);
  });
});
io.listen(9001, () => {
  console.log("Socket.io server listening on port 9001");
});

app.get("/logs/:id", async (req, res) => {
  const id = req.params.id;
  const logs = await client.query({
    query: `SELECT event_id, deployment_id, log, timestamp from log_events where deployment_id = {deployment_id:String}`,
    query_params: {
      deployment_id: id,
    },
    format: "JSONEachRow",
  });

  const rawLogs = await logs.json();

  return res.json({ logs: rawLogs });
});

async function initKafkaConsumer() {
  await consumer.connect();
  await consumer.subscribe({ topic: `container-logs` });

  await consumer.run({
    autoCommit: false,
    eachBatch: async ({
      batch,
      heartbeat,
      commitOffsetsIfNecessary,
      resolveOffset,
      isRunning,
      isStale,
    }) => {
      const messages = batch.messages;
      console.log(`Processing batch of ${messages.length} messages`);
      for (const message of messages) {
        const stringMessage = message.value.toString();
        const { DEPLOYMENT_ID, PROJECT_ID, log } = JSON.parse(stringMessage);
        const { query_id } = await client.insert({
          table: "log_events",
          values: [
            {
              event_id: uuidv4(),
              deployment_id: DEPLOYMENT_ID,
              log,
            },
          ],
          format: "JSONEachRow",
        });
        console.log(`Inserted log event with query id: ${query_id}`);
        resolveOffset(message.offset);
        await commitOffsetsIfNecessary(message.offset);
        await heartbeat();
      }
    },
  });
}

initKafkaConsumer();
