// Плагин OpenCode 2.x «user-content»: модель сама решает, кому адресован результат вызова инструмента.
//
// К каждому инструменту добавляется необязательный аргумент `audience`:
//   "assistant" (по умолчанию) — результат, как обычно, возвращается модели;
//   "user" — файлы из результата (например, изображения) сохраняются для пользователя и модели не возвращаются.
//
// Сохранённые файлы модель получает в виде путей и показывает пользователю, вставляя их в итоговый ответ
// Markdown-разметкой: ![подпись](/путь/к/файлу.jpg). Чат OpenCode отрисовывает такие картинки сам, читая файл
// с сервера, — это обычная часть ответа, видимая в любом клиенте. Серверам инструментов знать об `audience`
// не нужно: плагин убирает аргумент до вызова и сам помнит, какие вызовы адресованы пользователю.
//
// Опции плагина: directory — каталог для файлов (по умолчанию ~/.local/share/opencode/user-content).

import { mkdir, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

const EXTENSIONS = {
	"image/jpeg": "jpg",
	"image/png": "png",
	"image/webp": "webp",
	"image/gif": "gif",
	"image/avif": "avif",
	"image/bmp": "bmp",
	"image/svg+xml": "svg",
}

const AUDIENCE = {
	type: "string",
	enum: ["assistant", "user"],
	description:
		'Who the result is for. "assistant" (default): the result is returned to you. ' +
		'"user": files in the result (e.g. images) are saved for the user and NOT returned to you; you get their ' +
		"paths and show them by embedding them in your final answer as Markdown images.",
}

const CODE_MODE_NOTE =
	'Every tool called from code also accepts an optional `audience` argument: "assistant" (default) returns the ' +
	'result to you; "user" saves files from the result (e.g. images) for the user instead of returning them to you, ' +
	"and their paths are listed in this tool's result. Look at candidates with the default audience, then request " +
	'the ones the user should see with audience "user" and embed them in your final answer as ![description](path).'

// Описание параметра в схеме — слабая подсказка: без явного правила модель охотнее отвечает ссылками.
const SYSTEM_RULE =
	"Showing files to the user: tools accept an optional `audience` argument. When the user asks to show, send or " +
	'share images or other files, request them with audience "user" — you get their saved paths instead of the ' +
	"content — and embed them in your final answer as Markdown, e.g. ![description](path). Do not answer with " +
	"links instead of the files themselves. To choose which files to show, you may first look at candidates with " +
	"the default audience."

export default {
	id: "user-content",
	setup: async (ctx) => {
		const root =
			typeof ctx.options?.directory === "string"
				? ctx.options.directory
				: path.join(os.homedir(), ".local", "share", "opencode", "user-content")

		// Аргументы вызовов с audience: "user". Хуки before и after получают один и тот же объект аргументов.
		const forUser = new WeakSet()
		// id выполняющихся вызовов execute: вложенные вызовы Code Mode идут с тем же id.
		const running = new Set()
		// id вызова execute → файлы, сохранённые во вложенных вызовах.
		const savedInExecute = new Map()

		await ctx.session.hook("context", (event) => {
			// SystemPart в OpenCode — это { type: "text", text }; в конце системного промпта, чтобы не сбивать кэш префикса.
			event.system.push({ type: "text", text: SYSTEM_RULE })

			for (const [name, tool] of Object.entries(event.tools)) {
				if (name === "execute") {
					event.tools[name] = { ...tool, description: `${tool.description}\n\n${CODE_MODE_NOTE}` }
					continue
				}
				const input = tool.input
				if (input && typeof input === "object" && input.type === "object") {
					event.tools[name] = {
						...tool,
						input: { ...input, properties: { ...(input.properties ?? {}), audience: AUDIENCE } },
					}
				}
			}
		})

		await ctx.tool.hook("execute.before", (event) => {
			if (event.tool === "execute") {
				running.add(event.id)
				return
			}
			const input = event.input
			if (!input || typeof input !== "object" || !("audience" in input)) return
			const audience = input.audience
			delete input.audience
			if (audience === "user") forUser.add(input)
		})

		await ctx.tool.hook("execute.after", async (event) => {
			if (event.tool === "execute") {
				// Код может не вывести текст вложенного вызова — дублируем пути в результате execute.
				running.delete(event.id)
				const saved = savedInExecute.get(event.id)
				savedInExecute.delete(event.id)
				if (event.status === "completed" && saved?.length) event.result = appendText(event.result, describe(saved))
				return
			}

			if (event.status !== "completed" || !forUser.has(event.input)) return

			const content =
				typeof event.result.content === "string"
					? [{ type: "text", text: event.result.content }]
					: [...(event.result.content ?? [])]
			const files = content.filter((item) => item.type === "file")
			if (files.length === 0) return

			const saved = []
			for (const [index, file] of files.entries()) {
				saved.push(await save(root, event.sessionID, event.id, savedInExecute.get(event.id)?.length ?? 0, index, file))
			}

			event.result = {
				...event.result,
				content: [...content.filter((item) => item.type !== "file"), { type: "text", text: describe(saved) }],
			}
			if (running.has(event.id)) savedInExecute.set(event.id, [...(savedInExecute.get(event.id) ?? []), ...saved])
		})
	},
}

/** Сохраняет файл из результата инструмента; возвращает путь для Markdown и признак изображения. */
async function save(root, sessionID, callID, offset, index, file) {
	const data = /^data:([^;,]*)(;base64)?,(.*)$/s.exec(file.uri)
	if (!data) {
		// http(s) или file:// — сохранять нечего, отдаём ссылку как есть.
		const local = file.uri.startsWith("file://") ? decodeURIComponent(new URL(file.uri).pathname) : file.uri
		return { target: local, name: file.name, image: (file.mime ?? "").startsWith("image/") }
	}

	const mime = file.mime ?? (data[1] || "application/octet-stream")
	const directory = path.join(root, safe(sessionID))
	await mkdir(directory, { recursive: true })
	const target = path.join(directory, `${safe(callID)}-${offset + index + 1}.${EXTENSIONS[mime] ?? "bin"}`)
	await writeFile(target, data[2] ? Buffer.from(data[3], "base64") : Buffer.from(decodeURIComponent(data[3])))
	return { target: target.split(path.sep).join("/"), name: file.name, image: mime.startsWith("image/") }
}

function describe(saved) {
	const lines = saved.map(({ target, name, image }) =>
		image ? `![${name ?? "image"}](${encodeURI(target)})` : `[${name ?? "file"}](${encodeURI(target)})`,
	)
	return (
		`${saved.length} file(s) were saved for the user and are NOT shown to you. The user sees only those you ` +
		`embed in your final answer, as Markdown:\n${lines.join("\n")}`
	)
}

function appendText(result, text) {
	const content =
		typeof result.content === "string" ? [{ type: "text", text: result.content }] : [...(result.content ?? [])]
	return { ...result, content: [...content, { type: "text", text }] }
}

function safe(value) {
	return String(value).replace(/[^A-Za-z0-9_-]/g, "_")
}
