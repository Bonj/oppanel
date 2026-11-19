-- Optional: read-only database user. Run as root on the PBX:  mysql < deploy/db-grants.sql
-- Replace the password first. Only four tables are readable; nothing else in the asterisk database.
CREATE USER 'oppanel'@'localhost' IDENTIFIED BY 'CHANGE_ME_LONG_RANDOM';
GRANT SELECT ON asterisk.ringgroups TO 'oppanel'@'localhost';
GRANT SELECT ON asterisk.queues_config TO 'oppanel'@'localhost';
GRANT SELECT ON asterisk.ivr_details TO 'oppanel'@'localhost';
GRANT SELECT ON asterisk.meetme TO 'oppanel'@'localhost';
