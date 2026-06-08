import { describe, expect, it } from 'vitest';

import { TOUCHAI_BUILTIN_SYSTEM_PROMPT } from '@/services/AgentService/prompt/builtin';

describe('browser error attribution prompt guidance', () => {
    it('tells the model not to conflate local browser CDP failures with external web fetch failures', () => {
        expect(TOUCHAI_BUILTIN_SYSTEM_PROMPT).toContain('local browser CDP');
        expect(TOUCHAI_BUILTIN_SYSTEM_PROMPT).toContain('external website or network fetch');
        expect(TOUCHAI_BUILTIN_SYSTEM_PROMPT).toContain('Do not conflate these failure modes');
    });

    it('guides source collection tasks toward authoritative visual reports', () => {
        expect(TOUCHAI_BUILTIN_SYSTEM_PROMPT).toContain(
            'Research, Source Collection, And Decision Support'
        );
        expect(TOUCHAI_BUILTIN_SYSTEM_PROMPT).toContain('official or primary sources');
        expect(TOUCHAI_BUILTIN_SYSTEM_PROMPT).toContain('daily-life decisions');
        expect(TOUCHAI_BUILTIN_SYSTEM_PROMPT).toContain('original images');
        expect(TOUCHAI_BUILTIN_SYSTEM_PROMPT).toContain('complete, usable report');
    });

    it('requires a research plan before deep high-impact investigations', () => {
        expect(TOUCHAI_BUILTIN_SYSTEM_PROMPT).toContain(
            'major, high-impact, broad, ambiguous, or domain-level research questions'
        );
        expect(TOUCHAI_BUILTIN_SYSTEM_PROMPT).toContain('formulate a detailed research plan');
        expect(TOUCHAI_BUILTIN_SYSTEM_PROMPT).toContain('core questions');
        expect(TOUCHAI_BUILTIN_SYSTEM_PROMPT).toContain('source strategy');
        expect(TOUCHAI_BUILTIN_SYSTEM_PROMPT).toContain('execute the plan step by step');
    });

    it('matches research depth to topic stakes and keeps expanding evidence', () => {
        expect(TOUCHAI_BUILTIN_SYSTEM_PROMPT).toContain('Match research depth to stakes');
        expect(TOUCHAI_BUILTIN_SYSTEM_PROMPT).toContain('strategic decisions');
        expect(TOUCHAI_BUILTIN_SYSTEM_PROMPT).toContain('multiple authoritative sources');
        expect(TOUCHAI_BUILTIN_SYSTEM_PROMPT).toContain(
            'keep expanding until the evidence is sufficient'
        );
        expect(TOUCHAI_BUILTIN_SYSTEM_PROMPT).toContain('separate confirmed facts from interpretation');
    });

    it('tells the model to use browser control when access is restricted', () => {
        expect(TOUCHAI_BUILTIN_SYSTEM_PROMPT).toContain('access is restricted');
        expect(TOUCHAI_BUILTIN_SYSTEM_PROMPT).toContain('browser control');
    });

    it('requires visual evidence to be embedded when research images are available', () => {
        expect(TOUCHAI_BUILTIN_SYSTEM_PROMPT).toContain(
            'must actively try to collect relevant visuals'
        );
        expect(TOUCHAI_BUILTIN_SYSTEM_PROMPT).toContain('embed them with Markdown image syntax');
        expect(TOUCHAI_BUILTIN_SYSTEM_PROMPT).toContain('tool result provides a markdown image');
        expect(TOUCHAI_BUILTIN_SYSTEM_PROMPT).toContain(
            'Do not use copyright as a generic reason'
        );
        expect(TOUCHAI_BUILTIN_SYSTEM_PROMPT).toContain('explain why no suitable image is shown');
    });

    it('prevents decorative or misplaced research images', () => {
        expect(TOUCHAI_BUILTIN_SYSTEM_PROMPT).toContain('explanatory value');
        expect(TOUCHAI_BUILTIN_SYSTEM_PROMPT).toContain('software screenshots');
        expect(TOUCHAI_BUILTIN_SYSTEM_PROMPT).toContain(
            'embed them with Markdown image syntax near the related sections'
        );
        expect(TOUCHAI_BUILTIN_SYSTEM_PROMPT).toContain('not as a detached gallery at the end');
        expect(TOUCHAI_BUILTIN_SYSTEM_PROMPT).toContain('Avoid low-signal logos');
        expect(TOUCHAI_BUILTIN_SYSTEM_PROMPT).toContain('decorative stock photos');
    });

    it('treats visuals as a default deliverable for source collection reports', () => {
        expect(TOUCHAI_BUILTIN_SYSTEM_PROMPT).toContain(
            'Treat visual evidence as a default deliverable'
        );
        expect(TOUCHAI_BUILTIN_SYSTEM_PROMPT).toContain(
            'explicitly search or inspect for useful images'
        );
        expect(TOUCHAI_BUILTIN_SYSTEM_PROMPT).toContain(
            'Do not finish with text only when suitable visuals are available'
        );
    });

    it('requires a visual evidence workflow and final audit for research reports', () => {
        expect(TOUCHAI_BUILTIN_SYSTEM_PROMPT).toContain('visual evidence workflow');
        expect(TOUCHAI_BUILTIN_SYSTEM_PROMPT).toContain(
            'decide which sections need visual evidence'
        );
        expect(TOUCHAI_BUILTIN_SYSTEM_PROMPT).toContain('run a visual audit');
        expect(TOUCHAI_BUILTIN_SYSTEM_PROMPT).toContain(
            'the report is incomplete until it includes'
        );
    });

    it('encourages multiple high-value images when several report sections are visual', () => {
        expect(TOUCHAI_BUILTIN_SYSTEM_PROMPT).toContain(
            'Do not stop at a single token image'
        );
        expect(TOUCHAI_BUILTIN_SYSTEM_PROMPT).toContain('include multiple high-signal images');
        expect(TOUCHAI_BUILTIN_SYSTEM_PROMPT).toContain('one near each relevant section');
        expect(TOUCHAI_BUILTIN_SYSTEM_PROMPT).toContain('each image adds real explanatory value');
    });

    it('requires every embedded image to be explained and sourced in context', () => {
        expect(TOUCHAI_BUILTIN_SYSTEM_PROMPT).toContain('Every embedded image must earn its place');
        expect(TOUCHAI_BUILTIN_SYSTEM_PROMPT).toContain('what it shows');
        expect(TOUCHAI_BUILTIN_SYSTEM_PROMPT).toContain('why it matters');
        expect(TOUCHAI_BUILTIN_SYSTEM_PROMPT).toContain("webpage's original image");
    });

    it('tells the model to reuse useful original images returned by web_fetch', () => {
        expect(TOUCHAI_BUILTIN_SYSTEM_PROMPT).toContain('web_fetch returns article images');
        expect(TOUCHAI_BUILTIN_SYSTEM_PROMPT).toContain('original page images');
        expect(TOUCHAI_BUILTIN_SYSTEM_PROMPT).toContain('reuse the best ones');
        expect(TOUCHAI_BUILTIN_SYSTEM_PROMPT).toContain(
            'Use browser screenshots when original images are unavailable'
        );
    });
});
