import { visualReplyParser, visualReplySystemPrompt } from '@/services/VisualReplyService/library';

it('inspect schema', () => {
    const schema = visualReplyParser;
    console.log(visualReplySystemPrompt);
    console.log(JSON.stringify(schema, null, 0).slice(0, 200));
});
