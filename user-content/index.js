// Плагин OpenCode 2.x «user-content»: модель сама решает, кому адресован результат вызова инструмента.
//
// К каждому инструменту добавляется необязательный аргумент `audience`:
//   "assistant" (по умолчанию) — результат, как обычно, возвращается модели;
//   "user" — файлы из результата (например, изображения) показываются пользователю и в контекст модели не попадают.
//
// Файлы для пользователя переносятся из content результата (его видит модель) в metadata.user_content
// (её модель не видит): она хранится в истории сессии и приходит клиентам в событии session.tool.success,
// так что показать её может любой клиент. Серверам инструментов ничего знать об `audience` не нужно —
// плагин убирает аргумент до вызова и сам помнит, какие вызовы адресованы пользователю.

const KEY = "user_content"

const AUDIENCE = {
	type: "string",
	enum: ["assistant", "user"],
	description:
		'Who the result is for. "assistant" (default): the result is returned to you. ' +
		'"user": files in the result (e.g. images) are shown to the user in the chat and are NOT returned to you.',
}

const CODE_MODE_NOTE =
	'Every tool called from code also accepts an optional `audience` argument: "assistant" (default) returns the ' +
	'result to you; "user" shows files from the result (e.g. images) to the user in the chat and does NOT return ' +
	'them to you. Look at candidates with the default audience, then request the ones the user should see with ' +
	'audience "user".'

export default {
	id: "user-content",
	setup: async (ctx) => {
		// Аргументы вызовов с audience: "user". Хуки before и after получают один и тот же объект аргументов.
		const forUser = new WeakSet()
		// id выполняющихся вызовов execute: вложенные вызовы Code Mode идут с тем же id.
		const running = new Set()
		// id вызова execute → файлы для пользователя из его вложенных вызовов.
		const collected = new Map()

		await ctx.session.hook("context", (event) => {
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

		await ctx.tool.hook("execute.after", (event) => {
			if (event.tool === "execute") {
				running.delete(event.id)
				const files = collected.get(event.id)
				collected.delete(event.id)
				if (event.status === "completed" && files?.length) event.result = attach(event.result, files)
				return
			}

			if (event.status !== "completed" || !forUser.has(event.input)) return

			const content =
				typeof event.result.content === "string"
					? [{ type: "text", text: event.result.content }]
					: [...(event.result.content ?? [])]
			const files = content.filter((item) => item.type === "file")
			if (files.length === 0) return

			const note = {
				type: "text",
				text: `${files.length} file(s) were shown to the user and are not included here.`,
			}
			const result = { ...event.result, content: [...content.filter((item) => item.type !== "file"), note] }

			if (running.has(event.id)) {
				// Code Mode: metadata вложенного вызова не попадает в результат execute — прикрепим файлы к нему.
				collected.set(event.id, [...(collected.get(event.id) ?? []), ...files])
				event.result = result
			} else {
				event.result = attach(result, files)
			}
		})
	},
}

function attach(result, files) {
	const metadata = result.metadata ?? {}
	return { ...result, metadata: { ...metadata, [KEY]: [...(metadata[KEY] ?? []), ...files] } }
}
