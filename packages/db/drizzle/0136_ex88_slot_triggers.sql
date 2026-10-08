CREATE TRIGGER `qtm_t1_claim_exit` AFTER UPDATE OF `claimed_at`, `claim_token` ON `queued_thread_messages` WHEN OLD.`claimed_at` IS NOT NULL AND NEW.`claimed_at` IS NULL AND NEW.`forward_source_row_id` IS NULL AND EXISTS (SELECT 1 FROM `queued_thread_messages` AS `s` WHERE `s`.`forward_source_row_id` = OLD.`id` AND `s`.`claim_token` LIKE 'slot:%') BEGIN
DELETE FROM `queued_thread_messages` WHERE `forward_source_row_id` = OLD.`id` AND `claim_token` LIKE 'slot:%' AND `thread_id` IN (SELECT `id` FROM `threads` WHERE `deleted_at` IS NOT NULL);
UPDATE `transfer_entries` SET `state` = 'forwarded', `detail` = CASE WHEN EXISTS (SELECT 1 FROM `queued_thread_messages` AS `s` INNER JOIN `threads` AS `t` ON `t`.`id` = `s`.`thread_id` WHERE `s`.`forward_source_row_id` = OLD.`id` AND `s`.`claim_token` LIKE 'slot:%' AND `t`.`archived_at` IS NOT NULL) THEN 'target_archived' ELSE `detail` END, `updated_at` = CAST(ROUND((julianday('now') - 2440587.5) * 86400000) AS INTEGER) WHERE `kind` = 'slot' AND `state` = 'pending' AND `source_row_id` = OLD.`id` AND EXISTS (SELECT 1 FROM `queued_thread_messages` AS `s` WHERE `s`.`forward_source_row_id` = OLD.`id` AND `s`.`claim_token` LIKE 'slot:%');
UPDATE `queued_thread_messages` SET `claim_token` = 'fill:' || OLD.`id` WHERE `forward_source_row_id` = OLD.`id` AND `claim_token` LIKE 'slot:%';
DELETE FROM `queued_thread_messages` WHERE `id` = OLD.`id` AND EXISTS (SELECT 1 FROM `queued_thread_messages` AS `s` WHERE `s`.`forward_source_row_id` = OLD.`id` AND `s`.`claim_token` LIKE 'fill:%');
UPDATE `queued_thread_messages` SET `claimed_at` = NULL, `claim_token` = NULL, `forward_source_row_id` = NULL, `updated_at` = CAST(ROUND((julianday('now') - 2440587.5) * 86400000) AS INTEGER) WHERE `forward_source_row_id` = OLD.`id` AND `claim_token` LIKE 'fill:%';
END;--> statement-breakpoint
CREATE TRIGGER `qtm_t2_slot_deleted` AFTER DELETE ON `queued_thread_messages` WHEN OLD.`forward_source_row_id` IS NOT NULL AND OLD.`claim_token` LIKE 'slot:%' BEGIN
UPDATE `transfer_entries` SET `state` = CASE WHEN EXISTS (SELECT 1 FROM `queued_thread_messages` WHERE `id` = OLD.`forward_source_row_id`) THEN 'target_deleted' ELSE 'left_source' END, `updated_at` = CAST(ROUND((julianday('now') - 2440587.5) * 86400000) AS INTEGER) WHERE `kind` = 'slot' AND `state` = 'pending' AND `source_row_id` = OLD.`forward_source_row_id`;
DELETE FROM `queued_thread_messages` WHERE `id` = OLD.`forward_source_row_id`;
END;--> statement-breakpoint
CREATE TRIGGER `qtm_t3_source_deleted` AFTER DELETE ON `queued_thread_messages` WHEN OLD.`forward_source_row_id` IS NULL BEGIN
DELETE FROM `queued_thread_messages` WHERE `forward_source_row_id` = OLD.`id` AND `claim_token` LIKE 'slot:%';
END;
