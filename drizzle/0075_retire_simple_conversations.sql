-- Retire only the removed conversation feature. Work agents and project files are untouched.
DELETE FROM `simple_chat_messages`;
--> statement-breakpoint
DELETE FROM `simple_chat_threads`;
--> statement-breakpoint
DELETE FROM `conversation_owners` WHERE `kind` = 'simple';
--> statement-breakpoint
DELETE FROM `project_active_folders` WHERE `context_type` = 'simple_chat';
--> statement-breakpoint
UPDATE `project_tasks` SET `linked_simple_chat_id` = NULL WHERE `linked_simple_chat_id` IS NOT NULL;
--> statement-breakpoint
UPDATE `project_deliverables` SET `conversations` = (
  SELECT coalesce(json_group_array(json(value)), '[]')
  FROM json_each(`project_deliverables`.`conversations`)
  WHERE coalesce(json_extract(value, '$.type'), '') <> 'simple'
) WHERE json_valid(`conversations`);
--> statement-breakpoint
UPDATE `projects` SET `sidebar_order` = (
  SELECT coalesce(json_group_array(value), '[]')
  FROM json_each(`projects`.`sidebar_order`) WHERE value NOT LIKE 'simple:%'
) WHERE json_valid(`sidebar_order`);
--> statement-breakpoint
-- Preserve knowledge proposals and review history, without dangling conversation links.
UPDATE `project_knowledge_proposals` SET `source_type` = 'retired' WHERE `source_type` = 'simple';
--> statement-breakpoint
DELETE FROM `settings` WHERE `category` = 'simple-chat' OR `key` IN ('simple-chat:backend', 'simple-chat:audio-backend');
