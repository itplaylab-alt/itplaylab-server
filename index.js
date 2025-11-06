import express from "express";
import cors from "cors";
import dotenv from "dotenv";
dotenv.config();

const app = express();
const PORT = process.env.PORT || 10000;

app.use(cors());
app.use(express.json());

// Health check for Render
app.get("/healthz", (req, res) => res.status(200).send("ok"));

// Root route
app.get("/", (req, res) => {
  res.send("🚀 ItplayLab Render Server Running! — " + new Date().toISOString());
});

// Example API
app.post("/echo", (req, res) => {
  res.json({ received: req.body, at: new Date().toISOString() });
});

app.listen(PORT, () => {
  console.log(`✅ Server started on port ${PORT}`);
});
