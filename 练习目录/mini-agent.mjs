import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const READ_TOOL = {
  type: "function",
  function: {
    name: "read",
    description: "读取教学文件，仅允许 lesson.txt 或 missing.txt。",
    parameters: {
      type: "object",
      properties: { path: { type: "string", enum: ["lesson.txt", "missing.txt"] } },
      required: ["path"],
      additionalProperties: false,
    },
  },
};

async function executeRead(call, readText) {
  try {
    if (call.function.name !== "read") throw new Error("不支持的工具");
    let args;
    try { args = JSON.parse(call.function.arguments); }
    catch { throw new Error("参数不是合法 JSON"); }
    if (!args || Array.isArray(args) || typeof args.path !== "string") {
      throw new Error("path 必须是文字");
    }
    if (Object.keys(args).length !== 1) throw new Error("只接受 path 参数");
    if (!["lesson.txt", "missing.txt"].includes(args.path)) {
      throw new Error("仅允许 lesson.txt 或 missing.txt");
    }
    const text = await readText(args.path);
    return { ok: true, text };
  } catch (error) {
    return { ok: false, error: error.message };
  }
}

export async function runAgent({
  question, askModel, maxSteps = 4, log = () => {},
  readText = (path) => readFile(new URL(path, import.meta.url), "utf8"),
}) {
  const messages = [
    { role: "system", content: "先用 read 读取指定文件，再根据结果回答。ok 为 false 时说明失败，不编造内容。" },
    { role: "user", content: question },
  ];
  const seenIds = new Set();
  log({ type: "input", question });

  for (let step = 1; step <= maxSteps; step++) {
    log({ type: "model_request", step, messageCount: messages.length });
    let assistant;
    let calls;
    try {
      const choice = await askModel(messages);
      assistant = choice.message;
      calls = assistant?.tool_calls ?? [];
      if (assistant?.role !== "assistant" || !Array.isArray(calls)) {
        throw new Error("模型回复格式不符合约定");
      }
      const expectedReason = calls.length > 0 ? "tool_calls" : "stop";
      if (choice.finish_reason !== expectedReason) {
        throw new Error(`模型未正常完成：${choice.finish_reason}`);
      }
      if (calls.length === 0 && (typeof assistant.content !== "string" || !assistant.content.trim())) {
        throw new Error("模型没有返回回答文字");
      }
      for (const call of calls) {
        if (typeof call.id !== "string" || !call.id || seenIds.has(call.id) ||
            call.type !== "function" || typeof call.function?.name !== "string" ||
            typeof call.function.arguments !== "string") {
          throw new Error("工具调用缺少必要字段或编号重复");
        }
        seenIds.add(call.id);
      }
    } catch (error) {
      log({ type: "model_error", step, error: error.message });
      return { status: "model_error", error: error.message, messages };
    }

    messages.push(assistant);
    log({ type: "model_response", step, message: assistant });
    if (calls.length === 0) {
      return { status: "answered", answer: assistant.content, messages };
    }
    for (const call of calls) {
      log({ type: "tool_start", id: call.id, name: call.function.name });
      const result = await executeRead(call, readText);
      messages.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify(result) });
      log({ type: "tool_end", id: call.id, result });
    }
  }
  log({ type: "limit", maxSteps });
  return { status: "limit", error: "达到模型请求次数上限", messages };
}

export function createMockModel(mode = "ok") {
  return async (messages) => {
    if (mode === "model-error") throw new Error("模拟模型服务连接失败");
    const last = messages.at(-1);
    if (last.role === "tool" && mode !== "loop") {
      const result = JSON.parse(last.content);
      const content = result.ok ? `文件内容：${result.text}` : `读取失败：${result.error}`;
      return { finish_reason: "stop", message: { role: "assistant", content } };
    }
    let args = JSON.stringify({ path: mode === "missing" ? "missing.txt" : "lesson.txt" });
    if (mode === "bad-args") args = JSON.stringify({ path: 7 });
    if (mode === "bad-json") args = "{";
    const id = `call_${messages.filter((message) => message.role === "assistant").length + 1}`;
    return {
      finish_reason: "tool_calls",
      message: { role: "assistant", content: null, tool_calls: [{
        id, type: "function",
        function: { name: mode === "unknown-tool" ? "other" : "read", arguments: args },
      }] },
    };
  };
}

export async function askDeepSeek(messages, options = {}) {
  const apiKey = options.apiKey ?? process.env.DEEPSEEK_API_KEY;
  const model = options.model ?? process.env.DEEPSEEK_MODEL ?? "deepseek-flash";
  if (!apiKey) throw new Error("未配置 DEEPSEEK_API_KEY");
  const fetchImpl = options.fetchImpl ?? fetch;
  const response = await fetchImpl("https://api.deepseek.com/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model, messages, tools: [READ_TOOL], stream: false,
      thinking: { type: "disabled" }, max_tokens: 1024,
    }),
    signal: AbortSignal.timeout(options.timeoutMs ?? 30000),
  });
  if (!response.ok) throw new Error(`模型服务 HTTP ${response.status}`);
  const data = await response.json();
  const choice = data.choices?.[0];
  if (!choice) throw new Error("模型服务没有返回 choice");
  return choice;
}

async function main() {
  const mode = process.argv[2] ?? "ok";
  const modes = ["ok", "missing", "bad-args", "bad-json", "loop", "model-error", "unknown-tool", "live"];
  if (!modes.includes(mode)) throw new Error("未知模式，请检查运行命令");
  console.log(JSON.stringify({ type: "mode", mode, live: mode === "live" }));
  const target = mode === "missing" ? "missing.txt" : "lesson.txt";
  const result = await runAgent({
    question: `请读取 ${target}，告诉我文件里的内容。`,
    askModel: mode === "live" ? askDeepSeek : createMockModel(mode),
    log: (event) => console.log(JSON.stringify(event)),
  });
  console.log(JSON.stringify({ type: "run_end", status: result.status, answer: result.answer, error: result.error }));
  if (result.status !== "answered") process.exitCode = 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => { console.error(error.message); process.exitCode = 1; });
}