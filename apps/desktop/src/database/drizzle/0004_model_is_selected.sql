ALTER TABLE `models` ADD `is_selected` integer DEFAULT 1 NOT NULL CHECK(is_selected IN (0, 1));
