CREATE TABLE `room_directory` (
	`room_id` text PRIMARY KEY NOT NULL,
	`listed` integer DEFAULT 0 NOT NULL,
	`status` text NOT NULL,
	`summary` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_directory_listed_status` ON `room_directory` (`listed`,`status`);--> statement-breakpoint
CREATE TABLE `name_preferences` (
	`token_hash` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`updated_at` integer NOT NULL
);
