CREATE TABLE `draft_events` (
	`draft_id` text NOT NULL,
	`sequence` integer NOT NULL,
	`event` text NOT NULL,
	PRIMARY KEY(`draft_id`, `sequence`)
);
--> statement-breakpoint
CREATE TABLE `draft_history` (
	`id` text PRIMARY KEY NOT NULL,
	`room_id` text NOT NULL,
	`status` text NOT NULL,
	`completed_at` integer,
	`summary` text NOT NULL,
	`event_count` integer NOT NULL,
	`results` blob
);
--> statement-breakpoint
CREATE INDEX `idx_draft_history_finished` ON `draft_history` (`status`,`completed_at`,`id`);