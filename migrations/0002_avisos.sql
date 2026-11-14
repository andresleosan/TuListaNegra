CREATE TABLE `subscription_notices` (
	`business_id` text NOT NULL,
	`kind` text NOT NULL,
	`expires_at` integer NOT NULL,
	`created_at` integer NOT NULL,
	`sent_at` integer,
	FOREIGN KEY (`business_id`) REFERENCES `businesses`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "notices_kind_ck" CHECK(kind IN ('TRES_DIAS', 'UN_DIA', 'VENCIDO'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `notices_uq` ON `subscription_notices` (`business_id`,`kind`,`expires_at`);