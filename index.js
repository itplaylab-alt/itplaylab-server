import express from "express";

const app = express();
const PORT = process.env.PORT || 10000;

app.get("/", (req, res) => {
  res.send("Hello from ItplayLab Server!");
});

app.listen(PORT, () => {
  console.log(`✅ Server is running on port ${PORT}`);
});

