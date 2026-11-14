ALTER TABLE `whatsapp_messages` ADD `debtor_id` text REFERENCES debtors(id);--> statement-breakpoint
ALTER TABLE `whatsapp_messages` ADD `routing_state` text;--> statement-breakpoint
ALTER TABLE `whatsapp_messages` ADD `routing_rule` text;