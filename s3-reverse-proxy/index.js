const express = require("express");
const httpProxy = require("http-proxy");

const app = express();
const PORT = 8000;

const basePath = ``;

const proxy = httpProxy.createProxy();

app.use((req, res) => {
  console.log("req.url:", req.url);
  console.log("req.path:", req.path);
  console.log("req.hostname:", req.hostname);

  const hostname = req.hostname;
  const subdomain = hostname.split(".")[0];

  //Custom domain handling can be done using db query

  const resolvesTo = `${basePath}/${subdomain}`;

  return proxy.web(req, res, { target: resolvesTo, changeOrigin: true });
});

proxy.on("proxyReq", (proxyReq, req, res) => {
  const url = req.url;
  if (url === "/") {
    proxyReq.path += `index.html`;
  }
});

app.listen(PORT, () => console.log(`Reverse Proxy Running..${PORT}`));
