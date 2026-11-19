CREATE TABLE `artifacts` (
	`run_id` text NOT NULL,
	`node_run_id` text NOT NULL,
	`type` text NOT NULL,
	`name` text NOT NULL,
	`path` text,
	`url` text,
	`created_at` text NOT NULL,
	PRIMARY KEY(`run_id`, `node_run_id`, `type`, `name`),
	FOREIGN KEY (`run_id`) REFERENCES `runs`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "artifacts_path_or_url" CHECK(("artifacts"."path" IS NULL) <> ("artifacts"."url" IS NULL))
);
--> statement-breakpoint
CREATE TABLE `comments` (
	`run_id` text NOT NULL,
	`id` text NOT NULL,
	`file` text NOT NULL,
	`kind` text NOT NULL,
	`text` text NOT NULL,
	`status` text NOT NULL,
	`delivered_at` text,
	`anchor` text,
	`thread` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	PRIMARY KEY(`run_id`, `id`),
	FOREIGN KEY (`run_id`) REFERENCES `runs`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "comments_anchor_json" CHECK(json_valid("comments"."anchor")),
	CONSTRAINT "comments_thread_json" CHECK(json_valid("comments"."thread"))
);
--> statement-breakpoint
CREATE TABLE `events` (
	`run_id` text NOT NULL,
	`seq` integer NOT NULL,
	`id` text NOT NULL,
	`ts` text NOT NULL,
	`type` text NOT NULL,
	`source` text NOT NULL,
	`node_id` text,
	`node_run_id` text,
	`stage` text,
	`schema_version` integer NOT NULL,
	`payload` text NOT NULL,
	PRIMARY KEY(`run_id`, `seq`),
	FOREIGN KEY (`run_id`) REFERENCES `runs`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "events_payload_json" CHECK(json_valid("events"."payload"))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `events_run_id_id_unique` ON `events` (`run_id`,`id`);--> statement-breakpoint
CREATE TABLE `projects` (
	`name` text PRIMARY KEY NOT NULL,
	`path` text NOT NULL,
	`git` text,
	`channel` text NOT NULL,
	`added_by` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`added_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE TABLE `runs` (
	`id` text PRIMARY KEY NOT NULL,
	`project` text NOT NULL,
	`name` text,
	`workflow` text NOT NULL,
	`workflow_path` text NOT NULL,
	`config` text,
	`terminal` text,
	`permission_mode` text,
	`source` text,
	`user_id` text,
	`inputs` text NOT NULL,
	`sessions` text NOT NULL,
	`tiers` text,
	`policies` text,
	`state` text,
	`last_event_seq` integer DEFAULT 0 NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`project`) REFERENCES `projects`(`name`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "runs_inputs_json" CHECK(json_valid("runs"."inputs")),
	CONSTRAINT "runs_sessions_json" CHECK(json_valid("runs"."sessions")),
	CONSTRAINT "runs_tiers_json" CHECK(json_valid("runs"."tiers")),
	CONSTRAINT "runs_policies_json" CHECK(json_valid("runs"."policies")),
	CONSTRAINT "runs_state_json" CHECK(json_valid("runs"."state"))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `runs_project_name_unique` ON `runs` (`project`,`name`);--> statement-breakpoint
CREATE TABLE `trigger_fires` (
	`trigger_id` text NOT NULL,
	`slot` text NOT NULL,
	`status` text NOT NULL,
	`reason` text,
	`run_id` text,
	`run_name` text,
	`at` text NOT NULL,
	FOREIGN KEY (`trigger_id`) REFERENCES `triggers`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`run_id`) REFERENCES `runs`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `trigger_fires_by_trigger` ON `trigger_fires` (`trigger_id`,`at`);--> statement-breakpoint
CREATE TABLE `triggers` (
	`id` text PRIMARY KEY NOT NULL,
	`project` text NOT NULL,
	`name` text NOT NULL,
	`workflow` text NOT NULL,
	`config` text,
	`cron` text NOT NULL,
	`timezone` text NOT NULL,
	`next_fire_at` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`project`) REFERENCES `projects`(`name`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `triggers_project_name_unique` ON `triggers` (`project`,`name`);--> statement-breakpoint
CREATE TABLE `user_accounts` (
	`user_id` text NOT NULL,
	`provider` text NOT NULL,
	`provider_id` text NOT NULL,
	`username` text,
	`token` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	PRIMARY KEY(`user_id`, `provider`),
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `user_accounts_provider_provider_id_unique` ON `user_accounts` (`provider`,`provider_id`);--> statement-breakpoint
CREATE TABLE `users` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`email` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
