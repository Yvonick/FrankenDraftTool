CREATE TABLE `mutation_guard` (
	`id` integer PRIMARY KEY NOT NULL
);
--> statement-breakpoint
CREATE TABLE `pools` (
	`id` text PRIMARY KEY NOT NULL,
	`revision` integer NOT NULL,
	`object_key` text NOT NULL,
	`summary` text NOT NULL,
	`deleted` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE `page_presence` (
	`id` text PRIMARY KEY NOT NULL,
	`last_seen` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_presence_last_seen` ON `page_presence` (`last_seen`);--> statement-breakpoint
CREATE TABLE `rooms` (
	`id` text PRIMARY KEY NOT NULL,
	`revision` integer NOT NULL,
	`state` blob NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `room_sessions` (
	`room_id` text NOT NULL,
	`participant_id` text NOT NULL,
	`token_hash` text NOT NULL,
	`last_seen` integer NOT NULL,
	PRIMARY KEY(`room_id`, `participant_id`)
);
