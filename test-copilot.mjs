import { CopilotClient, approveAll } from "@github/copilot-sdk";

const client = new CopilotClient({ logLevel: "error" });

try {
	await client.start();

	const session = await client.createSession({
		model: "gpt-5",
		onPermissionRequest: approveAll,
	});

	session.on("assistant.message", (event) => {
		process.stdout.write(`${event.data.content}\n`);
	});

	const idle = new Promise((resolve) => session.on("session.idle", resolve));
	await session.send({ prompt: "Reply with exactly: copilot bridge works" });
	await idle;
	await session.disconnect();
} finally {
	await client.stop();
}
