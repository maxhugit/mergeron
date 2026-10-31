CREATE TABLE `person_navigation_preferences` (
  `person_id` text PRIMARY KEY NOT NULL REFERENCES `people`(`id`) ON DELETE CASCADE,
  `fast_navigation_project_id` text REFERENCES `projects`(`id`) ON DELETE SET NULL
);
