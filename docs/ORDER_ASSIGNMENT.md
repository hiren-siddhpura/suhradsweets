# Order assignment

Only an active Admin sees the order user filter and new-order assignee selector. Eligible profiles are active admin, account_admin or user records, identified by their existing document UID; inactive/invalid profiles and duplicate UIDs are excluded. Account Admin and User new orders belong to the actor UID. The trusted backend rejects forged assignment requests and preserves existing draft ownership for all roles, while staff retain general editing access. Customer ownership links continue to be added atomically from the validated order owner. Direct client order writes remain denied; no Rules or index changes are needed.

Purchase and order writes still require the trusted callable backend. Local changes do not deploy it; live use depends on a reviewed deployment.
