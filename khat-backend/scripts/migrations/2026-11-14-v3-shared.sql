-- v3 shared: video link per step
ALTER TABLE level_steps ADD COLUMN video_url varchar(500) DEFAULT NULL;
