const { DatabaseSync } = require('node:sqlite');
const db = new DatabaseSync(
    'D:/Project/TouchAI/.worktrees/perf-raycast-plan/apps/desktop/data/touchai.db',
    { readOnly: true }
);

const rows = db
    .prepare(
        `select m.id, m.role,
                sum(case when p.type = 'text' then length(coalesce(p.content,'')) else 0 end) as text_chars,
                sum(case when p.type = 'reasoning' then length(coalesce(p.content,'')) else 0 end) as reasoning_chars,
                sum(case when p.type = 'tool_call' then 1 else 0 end) as tool_parts,
                count(p.id) as parts
         from messages m left join message_parts p on p.message_id = m.id
         where m.session_id = 1
         group by m.id
         order by text_chars desc
         limit 10`
    )
    .all();

for (const row of rows) {
    console.log(
        `msg ${row.id} role=${row.role} parts=${row.parts} text=${row.text_chars} reasoning=${row.reasoning_chars} tools=${row.tool_parts}`
    );
}

const longest = db
    .prepare(
        `select id, message_id, type, length(content) as len from message_parts
         where message_id in (select id from messages where session_id = 1)
         order by len desc limit 6`
    )
    .all();
console.log('--- 最长 part');
for (const part of longest) {
    console.log(`part ${part.id} msg=${part.message_id} type=${part.type} chars=${part.len}`);
}
db.close();