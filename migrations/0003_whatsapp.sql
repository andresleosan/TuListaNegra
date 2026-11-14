CREATE TABLE `whatsapp_messages` (
	`id` text PRIMARY KEY NOT NULL,
	`direction` text NOT NULL,
	`wa_message_id` text,
	`request_id` text,
	`phone` text NOT NULL,
	`phone_number_id` text,
	`business_id` text,
	`kind` text NOT NULL,
	`template` text,
	`content_json` text NOT NULL,
	`buttons_json` text,
	`reply_to_wa_message_id` text,
	`status` text NOT NULL,
	`error_code` text,
	`callback_data` text,
	`occurred_at` integer NOT NULL,
	`created_at` integer NOT NULL,
	`status_updated_at` integer,
	FOREIGN KEY (`business_id`) REFERENCES `businesses`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "wa_direction_ck" CHECK(direction IN ('ENTRANTE', 'SALIENTE')),
	CONSTRAINT "wa_kind_ck" CHECK(kind IN ('template', 'text', 'buttons', 'image', 'button')),
	CONSTRAINT "wa_status_ck" CHECK(status IN ('accepted', 'rejected', 'unknown', 'sent', 'delivered', 'read', 'failed')),
	CONSTRAINT "wa_ids_ck" CHECK(("whatsapp_messages"."direction" = 'ENTRANTE' AND "whatsapp_messages"."wa_message_id" IS NOT NULL) OR ("whatsapp_messages"."direction" = 'SALIENTE' AND "whatsapp_messages"."request_id" IS NOT NULL))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `wa_message_id_uq` ON `whatsapp_messages` (`wa_message_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `wa_request_id_uq` ON `whatsapp_messages` (`request_id`);--> statement-breakpoint
CREATE INDEX `wa_phone_idx` ON `whatsapp_messages` (`phone`,`direction`,`occurred_at`);