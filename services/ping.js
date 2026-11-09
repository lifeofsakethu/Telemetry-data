module.exports = async ({ app, logger }) => {
  app.get("/service/ping", (req, res) => res.json({ status: "online", service: "NSYS ping" }));
  logger.info("NSYS service initialized: ping.js");
};
