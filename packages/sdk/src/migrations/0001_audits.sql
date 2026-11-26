CREATE TABLE `audit_metrics` (
	`audit_run_id` text NOT NULL,
	`repo` text NOT NULL,
	`metric` text NOT NULL,
	`scope` text NOT NULL,
	`status` text NOT NULL,
	`reason` text,
	`value` real,
	`how` text NOT NULL,
	PRIMARY KEY(`audit_run_id`, `repo`, `metric`, `scope`),
	FOREIGN KEY (`audit_run_id`) REFERENCES `audit_runs`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "audit_metrics_how_json" CHECK(json_valid("audit_metrics"."how"))
);
--> statement-breakpoint
CREATE TABLE `audit_result_events` (
	`id` text PRIMARY KEY NOT NULL,
	`result_id` text NOT NULL,
	`type` text NOT NULL,
	`who` text NOT NULL,
	`ts` text NOT NULL,
	`started_run_id` text,
	`payload` text NOT NULL,
	FOREIGN KEY (`result_id`) REFERENCES `audit_results`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`started_run_id`) REFERENCES `runs`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "audit_result_events_payload_json" CHECK(json_valid("audit_result_events"."payload"))
);
--> statement-breakpoint
CREATE INDEX `audit_result_events_by_result` ON `audit_result_events` (`result_id`);--> statement-breakpoint
CREATE TABLE `audit_results` (
	`id` text PRIMARY KEY NOT NULL,
	`audit_run_id` text NOT NULL,
	`repo` text NOT NULL,
	`problem_type` text NOT NULL,
	`state` text NOT NULL,
	`title` text NOT NULL,
	`proof` text NOT NULL,
	`fix` text,
	FOREIGN KEY (`audit_run_id`) REFERENCES `audit_runs`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "audit_results_proof_json" CHECK(json_valid("audit_results"."proof")),
	CONSTRAINT "audit_results_fix_json" CHECK(json_valid("audit_results"."fix"))
);
--> statement-breakpoint
CREATE INDEX `audit_results_by_audit_run` ON `audit_results` (`audit_run_id`);--> statement-breakpoint
CREATE TABLE `audit_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`run_id` text NOT NULL,
	`project` text NOT NULL,
	`audit` text NOT NULL,
	`period_start` text NOT NULL,
	`period_end` text NOT NULL,
	`commits` text NOT NULL,
	`status` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`run_id`) REFERENCES `runs`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`project`) REFERENCES `projects`(`name`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "audit_runs_commits_json" CHECK(json_valid("audit_runs"."commits"))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `audit_runs_run_id_unique` ON `audit_runs` (`run_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `audit_runs_project_audit_period_start_period_end_unique` ON `audit_runs` (`project`,`audit`,`period_start`,`period_end`);