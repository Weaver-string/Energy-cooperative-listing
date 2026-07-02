const { handler } = require("../server");

module.exports = async function vercelHandler(req, res) {
  if (!process.env.DATABASE_URL) {
    res.statusCode = 500;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.end(JSON.stringify({ error: "DATABASE_URL is required on Vercel." }));
    return;
  }

  try {
    await handler(req, res);
  } catch (error) {
    console.error(error);
    if (!res.headersSent) {
      res.statusCode = 500;
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      res.end(JSON.stringify({ error: "Serverless function failed. Check Vercel logs for details." }));
    } else {
      res.end();
    }
  }
};
