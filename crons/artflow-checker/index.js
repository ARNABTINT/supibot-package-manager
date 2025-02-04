module.exports = {
	Name: "artflow-checker",
	Expression: "*/30 * * * * *",
	Description: "Checks active artflow.ai requests created by users, and determines their status",
	Defer: (() => ({
		start: 0,
		end: 5000
	})),
	Type: "Bot",
	Code: (async function artflowChecker () {
		const activePrompts = await sb.Cache.server.hgetall("artflow");
		if (!activePrompts || Object.keys(activePrompts).length === 0) {
			return;
		}

		for (const [key, rawValue] of Object.entries(activePrompts)) {
			const value = (typeof rawValue === "string") ? JSON.parse(rawValue) : rawValue;
			const reminderData = {
				Channel: null,
				User_From: 1127,
				User_To: value.user,
				Schedule: null,
				Created: new sb.Date(),
				Private_Message: true,
				Platform: value.platform ?? 1
			};

			const savedImageData = await sb.Query.getRecordset(rs => rs
				.select("Upload_Link")
				.from("data", "Artflow_Image")
				.where("ID = %s", String(value.imageIndex))
				.limit(1)
				.single()
			);

			if (savedImageData) {
				reminderData.Text = `Your Artflow prompt "${value.prompt}" has finished: ${savedImageData.Upload_Link}`;

				await sb.Reminder.create(reminderData, true);
				await sb.Cache.server.hdel("artflow", key);
				continue;
			}

			const formData = new sb.Got.FormData();
			formData.append("my_work_id", value.imageIndex);

			const check = await sb.Got("FakeAgent", {
				method: "POST",
				url: "https://artflow.ai/check_status",
				headers: {
					"x-requested-with": "XMLHttpRequest",
					...formData.getHeaders()
				},
				body: formData.getBuffer(),
				referrer: "https://artflow.ai/"
			});

			const statusCodeDigit = Math.trunc(check.statusCode / 100);
			if (statusCodeDigit === 5) { // 5xx response, API failed - ignore
				continue;
			}
			else if (statusCodeDigit === 4 || check.statusCode !== 200) { // 4xx or other non-200 response
				reminderData.Text = `Your Artflow prompt "${value.prompt}" has failed with status code ${check.statusCode}! Please try again.`;
				await sb.Reminder.create(reminderData, true);
				await sb.Cache.server.hdel("artflow", key);

				continue;
			}
			else if (check.body.current_rank > -1) { // still pending
				value.queue = check.body.current_rank;
				await sb.Cache.server.hset("artflow", key, JSON.stringify(value));

				continue;
			}
			else if (!check.body.filename) {
				reminderData.Text = `Your Artflow prompt "${value.prompt}" succeeded, but the API did not return a filename. Try using $artflow (your prompt) to saerch for it.`;
				await sb.Reminder.create(reminderData, true);
				await sb.Cache.server.hdel("artflow", key);

				continue;
			}

			const [result] = await sb.Utils.processArtflowData([{
				filename: check.body.filename,
				userDataID: value.user,
				userID: value.artflowUserID,
				text_prompt: value.prompt,
				textPrompt: value.prompt,
				index: value.imageIndex,
				status: "Finished"
			}]);

			if (result.link) {
				reminderData.Text = `Your Artflow prompt "${value.prompt}" has finished: ${result.link}`;
			}
			else {
				reminderData.Text = `Your Artflow prompt "${value.prompt}" failed with this reason: ${result.reason}`;
			}

			await sb.Reminder.create(reminderData, true);
			await sb.Cache.server.hdel("artflow", key);
		}
	})
};
