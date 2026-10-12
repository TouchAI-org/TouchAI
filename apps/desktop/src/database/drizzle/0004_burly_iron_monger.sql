CREATE TABLE `message_parts` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`message_id` integer NOT NULL,
	`type` text NOT NULL,
	`content` text NOT NULL,
	`started_at` integer,
	`ended_at` integer,
	`sort_order` integer NOT NULL,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	`updated_at` text DEFAULT (datetime('now')) NOT NULL,
	FOREIGN KEY (`message_id`) REFERENCES `messages`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `message_parts_message_id_sort_order_idx` ON `message_parts` (`message_id`,`sort_order`);--> statement-breakpoint
-- Preserve existing messages before removing their legacy content columns.
INSERT INTO `message_parts` (`message_id`, `type`, `content`, `sort_order`, `created_at`, `updated_at`)
SELECT `id`, 'reasoning', `reasoning`, 0, `created_at`, `updated_at`
FROM `messages` WHERE coalesce(`reasoning`, '') <> '';
--> statement-breakpoint
INSERT INTO `message_parts` (`message_id`, `type`, `content`, `sort_order`, `created_at`, `updated_at`)
SELECT `id`, 'text', `content`, CASE WHEN coalesce(`reasoning`, '') <> '' THEN 1 ELSE 0 END, `created_at`, `updated_at`
FROM `messages` WHERE `content` <> '';
--> statement-breakpoint
ALTER TABLE `messages` DROP COLUMN `content`;--> statement-breakpoint
ALTER TABLE `messages` DROP COLUMN `reasoning`;
--> statement-breakpoint
-- Derived search index only: message_parts remains the sole content store.
-- detail=none stores document IDs without token positions. Search verifies candidates
-- against ordered text parts, preserving literal substring and cross-part matches.
CREATE VIRTUAL TABLE `message_search_fts` USING fts5(
    content,
    content='',
    contentless_delete=1,
    tokenize='trigram',
    detail=none
);
--> statement-breakpoint
INSERT INTO message_search_fts(rowid, content)
SELECT message_id, group_concat(content, '')
FROM (
    SELECT message_id, content FROM message_parts
    WHERE type = 'text'
    ORDER BY message_id, sort_order, id
)
GROUP BY message_id;
--> statement-breakpoint
CREATE TRIGGER trg_message_parts_search_insert
AFTER INSERT ON message_parts
WHEN NEW.type = 'text'
BEGIN
    INSERT OR REPLACE INTO message_search_fts(rowid, content)
    SELECT messages.id, (
        SELECT group_concat(content, '') FROM (
            SELECT content FROM message_parts
            WHERE message_id = messages.id AND type = 'text'
            ORDER BY sort_order, id
        )
    )
    FROM messages
    WHERE messages.id IN (NEW.message_id)
      AND EXISTS (SELECT 1 FROM message_parts WHERE message_id = messages.id AND type = 'text');
END;
--> statement-breakpoint
CREATE TRIGGER trg_message_parts_search_delete
AFTER DELETE ON message_parts
WHEN OLD.type = 'text'
BEGIN
    DELETE FROM message_search_fts WHERE rowid = OLD.message_id;
    INSERT OR REPLACE INTO message_search_fts(rowid, content)
    SELECT messages.id, (
        SELECT group_concat(content, '') FROM (
            SELECT content FROM message_parts
            WHERE message_id = messages.id AND type = 'text'
            ORDER BY sort_order, id
        )
    )
    FROM messages
    WHERE messages.id IN (OLD.message_id)
      AND EXISTS (SELECT 1 FROM message_parts WHERE message_id = messages.id AND type = 'text');
END;
--> statement-breakpoint
CREATE TRIGGER trg_message_parts_search_update
AFTER UPDATE OF message_id, type, content, sort_order ON message_parts
WHEN (OLD.type = 'text' OR NEW.type = 'text')
 AND (OLD.message_id <> NEW.message_id OR OLD.type <> NEW.type
      OR OLD.content <> NEW.content OR OLD.sort_order <> NEW.sort_order)
BEGIN
    DELETE FROM message_search_fts WHERE rowid IN (OLD.message_id, NEW.message_id);
    INSERT OR REPLACE INTO message_search_fts(rowid, content)
    SELECT messages.id, (
        SELECT group_concat(content, '') FROM (
            SELECT content FROM message_parts
            WHERE message_id = messages.id AND type = 'text'
            ORDER BY sort_order, id
        )
    )
    FROM messages
    WHERE messages.id IN (OLD.message_id, NEW.message_id)
      AND EXISTS (SELECT 1 FROM message_parts WHERE message_id = messages.id AND type = 'text');
END;
