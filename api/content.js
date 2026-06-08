const DEFAULT_BRANCH = "main";
const DEFAULT_CONTENT_PATH = "content.json";

function json(res, status, payload) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify(payload));
}

function readAuth(req) {
  const header = req.headers.authorization || "";
  if (!header.startsWith("Basic ")) return null;

  try {
    const decoded = Buffer.from(header.slice(6), "base64").toString("utf8");
    const separator = decoded.indexOf(":");
    if (separator === -1) return null;
    return {
      user: decoded.slice(0, separator),
      password: decoded.slice(separator + 1)
    };
  } catch {
    return null;
  }
}

function isAuthorized(req) {
  const expectedUser = process.env.ADMIN_USER;
  const expectedPassword = process.env.ADMIN_PASSWORD;
  if (!expectedUser || !expectedPassword) return false;

  const auth = readAuth(req);
  return auth && auth.user === expectedUser && auth.password === expectedPassword;
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

function getGithubConfig() {
  return {
    token: process.env.GITHUB_TOKEN,
    owner: process.env.GITHUB_OWNER || process.env.VERCEL_GIT_REPO_OWNER,
    repo: process.env.GITHUB_REPO || process.env.VERCEL_GIT_REPO_SLUG,
    branch: process.env.GITHUB_BRANCH || DEFAULT_BRANCH,
    path: process.env.CONTENT_PATH || DEFAULT_CONTENT_PATH
  };
}

function validateContent(content) {
  if (!content || typeof content !== "object" || Array.isArray(content)) {
    return "内容必须是一个 JSON 对象。";
  }

  if (!content.site || typeof content.site !== "object") {
    return "缺少 site 配置。";
  }

  for (const key of ["works", "tutorials", "journal"]) {
    if (!Array.isArray(content[key])) {
      return `${key} 必须是数组。`;
    }
  }

  return "";
}

async function githubRequest(url, options, token) {
  const response = await fetch(url, {
    ...options,
    headers: {
      "Accept": "application/vnd.github+json",
      "Authorization": `Bearer ${token}`,
      "Content-Type": "application/json",
      "User-Agent": "AIGosling-admin",
      "X-GitHub-Api-Version": "2022-11-28",
      ...(options && options.headers ? options.headers : {})
    }
  });

  const text = await response.text();
  let data = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = { message: text };
    }
  }

  if (!response.ok) {
    const message = data && data.message ? data.message : "GitHub request failed";
    throw new Error(message);
  }

  return data;
}

async function getCurrentFile(config) {
  const url = `https://api.github.com/repos/${config.owner}/${config.repo}/contents/${encodeURIComponent(config.path)}?ref=${encodeURIComponent(config.branch)}`;
  return githubRequest(url, { method: "GET" }, config.token);
}

async function publishContent(content, config) {
  const current = await getCurrentFile(config);
  const pretty = `${JSON.stringify(content, null, 2)}\n`;
  const body = {
    message: "Update AIGosling website content",
    content: Buffer.from(pretty, "utf8").toString("base64"),
    sha: current.sha,
    branch: config.branch
  };
  const url = `https://api.github.com/repos/${config.owner}/${config.repo}/contents/${encodeURIComponent(config.path)}`;
  return githubRequest(url, { method: "PUT", body: JSON.stringify(body) }, config.token);
}

module.exports = async function handler(req, res) {
  if (req.method === "OPTIONS") {
    res.statusCode = 204;
    res.end();
    return;
  }

  const config = getGithubConfig();
  const missing = Object.entries(config)
    .filter(([, value]) => !value)
    .map(([key]) => key);

  if (req.method === "GET") {
    if (missing.length > 0) {
      json(res, 501, {
        ok: false,
        message: "GitHub publishing is not configured yet.",
        missing
      });
      return;
    }

    try {
      const file = await getCurrentFile(config);
      const decoded = Buffer.from(file.content || "", "base64").toString("utf8");
      json(res, 200, {
        ok: true,
        content: JSON.parse(decoded),
        sha: file.sha
      });
    } catch (error) {
      json(res, 500, { ok: false, message: error.message });
    }
    return;
  }

  if (req.method !== "POST") {
    json(res, 405, { ok: false, message: "Method not allowed" });
    return;
  }

  if (!isAuthorized(req)) {
    res.setHeader("WWW-Authenticate", "Basic realm=\"AIGosling Admin\"");
    json(res, 401, {
      ok: false,
      message: "后台账号或密码不正确，或 Vercel 尚未配置 ADMIN_USER / ADMIN_PASSWORD。"
    });
    return;
  }

  if (missing.length > 0) {
    json(res, 501, {
      ok: false,
      message: "缺少 GitHub 发布配置。请在 Vercel 环境变量里设置 GITHUB_TOKEN、GITHUB_OWNER、GITHUB_REPO。",
      missing
    });
    return;
  }

  try {
    const raw = await readBody(req);
    if (raw.length > 900000) {
      json(res, 413, { ok: false, message: "内容太大，请使用图片/视频 URL，不要把大型文件直接存进 JSON。" });
      return;
    }

    const parsed = JSON.parse(raw);
    const content = parsed.content || parsed;
    const validationError = validateContent(content);
    if (validationError) {
      json(res, 400, { ok: false, message: validationError });
      return;
    }

    const result = await publishContent(content, config);
    json(res, 200, {
      ok: true,
      message: "内容已提交到 GitHub，Vercel 会自动重新部署。",
      commit: result.commit && result.commit.sha
    });
  } catch (error) {
    json(res, 500, { ok: false, message: error.message });
  }
};
