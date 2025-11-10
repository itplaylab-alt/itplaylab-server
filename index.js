app.post("/content/brief", async (req, res) => {
try {
const idea = req.body || {};
const response_format = {
type: "json_schema",
json_schema: {
name: "content_brief",
strict: true,
schema: {
type: "object",
additionalProperties: false,
properties: {
brief_id: { type: "string" },
idea_id: { type: "string" },
goal: { type: "string" },
key_points: { type: "array", items: { type: "string" } },
hook: { type: "string" },
outline: {
type: "array",
items: {
type: "object",
properties: { sec: { type: "number" }, beat: { type: "string" } },
required: ["sec", "beat"]
}
},
channels: { type: "array", items: { type: "string" } },
due_date: { type: "string" },
owner: { type: "string" }
},
required: ["brief_id", "goal", "outline"]
}
}
};
const messages = [
{ role: "system", content: "너는 콘텐츠 프로듀서다. 60초 쇼츠 중심으로 간결한 브리프를 작성하라." },
{ role: "user", content: JSON.stringify(idea) }
];
const resp = await oa.responses.create({
model: process.env.OPENAI_MODEL || "gpt-4o-mini",
input: messages,
response_format
});
const brief = JSON.parse(resp.output_text || "{}");
await logToSheet({
type: "content_brief",
input_text: idea.title || "",
output_text: JSON.stringify(brief),
project: "itplaylab",
category: "brief",
note: "via /content/brief"
});
res.json({ ok: true, brief });
} catch (e) {
res.status(500).json({ ok: false, error: String(e?.message || e) });
}
});
