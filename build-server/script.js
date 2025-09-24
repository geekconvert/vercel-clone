const { exec } = require("child_process");
const path = require("path");
const fs = require("fs");
const { S3Client, PutObjectCommand } = require("@aws-sdk/client-s3");
const mime = require("mime-types");
const { Kafka } = require("kafkajs");

const s3Client = new S3Client({
  region: "us-east-1",
  credentials: {
    accessKeyId: "",
    secretAccessKey: "",
  },
});

const PROJECT_ID = process.env.PROJECT_ID;
const DEPLOYMENT_ID = process.env.DEPLOYMENT_ID;

const kafka = new Kafka({
  clientId: ``,
  brokers: [""],
  ssl: {
    ca: [fs.readFileSync(path.join(__dirname, "kafka.pem"), "utf-8")],
  },
  sasl: {
    username: "",
    password: "",
    mechanism: "",
  },
});

const producer = kafka.producer();

async function publishLog(log) {
  await producer.send({
    topic: "container-logs",
    messages: [
      {
        key: "log",
        value: JSON.stringify({ DEPLOYMENT_ID, PROJECT_ID, log }),
      },
    ],
  });
}

async function init() {
  console.log("executing script.js");
  await producer.connect();
  await publishLog("Build started...");
  const outputDir = path.join(__dirname, "output");

  const p = exec(`cd ${outputDir} && npm install && npm run build`);

  p.stdout.on("data", async (data) => {
    console.log(data.toString());
    await publishLog(data.toString());
  });

  p.stdout.on("error", async (data) => {
    console.error(data.toString());
    await publishLog(`Error: ${data.toString()}`);
  });

  p.on("close", async () => {
    console.log(`Build complete`);
    await publishLog("Build complete");
    const distFolderPath = path.join(outputDir, "dist");
    const distFolderContents = fs.readdirSync(distFolderPath, {
      recursive: true,
    });

    await publishLog("Starting to upload files...");
    for (const file of distFolderContents) {
      const filePath = path.join(distFolderPath, file);
      if (fs.lstatSync(filePath).isDirectory()) {
        continue;
      }

      console.log(`Uploading file: ${filePath}`);
      await publishLog(`Uploading file: ${file}`);

      const command = new PutObjectCommand({
        Bucket: "",
        Key: `__outputs/${PROJECT_ID}/${file}`,
        Body: fs.createReadStream(filePath),
        ContentType: mime.lookup(filePath),
      });

      await s3Client.send(command);
      console.log(`Uploaded file: ${filePath}`);
      await publishLog(`Uploaded file: ${file}`);
    }

    console.log("Done...");
    await publishLog("Done...");
    process.exit(0);
  });
}

init();
