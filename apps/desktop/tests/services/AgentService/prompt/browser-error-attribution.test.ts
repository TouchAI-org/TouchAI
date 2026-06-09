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
        expect(TOUCHAI_BUILTIN_SYSTEM_PROMPT).toContain('useful reference links');
    });

    it('requires a research plan before deep high-impact investigations', () => {
        expect(TOUCHAI_BUILTIN_SYSTEM_PROMPT).toContain('Match research depth to stakes');
        expect(TOUCHAI_BUILTIN_SYSTEM_PROMPT).toContain('require a research plan');
        expect(TOUCHAI_BUILTIN_SYSTEM_PROMPT).toContain('multiple authoritative sources');
        expect(TOUCHAI_BUILTIN_SYSTEM_PROMPT).toContain('enough detail for audit');
    });

    it('matches research depth to topic stakes and keeps expanding evidence', () => {
        expect(TOUCHAI_BUILTIN_SYSTEM_PROMPT).toContain('Match research depth to stakes');
        expect(TOUCHAI_BUILTIN_SYSTEM_PROMPT).toContain('strategic decisions');
        expect(TOUCHAI_BUILTIN_SYSTEM_PROMPT).toContain('multiple authoritative sources');
        expect(TOUCHAI_BUILTIN_SYSTEM_PROMPT).toContain(
            'keep expanding until the evidence is sufficient'
        );
        expect(TOUCHAI_BUILTIN_SYSTEM_PROMPT).toContain(
            'separate confirmed facts from interpretation'
        );
    });

    it('tells the model to use browser control when access is restricted', () => {
        expect(TOUCHAI_BUILTIN_SYSTEM_PROMPT).toContain('anti-bot/access friction');
        expect(TOUCHAI_BUILTIN_SYSTEM_PROMPT).toContain('browser control');
    });

    it('requires visual evidence to be embedded when research images are available', () => {
        expect(TOUCHAI_BUILTIN_SYSTEM_PROMPT).toContain('Actively look for software screenshots');
        expect(TOUCHAI_BUILTIN_SYSTEM_PROMPT).toContain('include suitable Markdown images');
        expect(TOUCHAI_BUILTIN_SYSTEM_PROMPT).toContain('Markdown image references');
        expect(TOUCHAI_BUILTIN_SYSTEM_PROMPT).toContain('Do not use copyright as a generic reason');
        expect(TOUCHAI_BUILTIN_SYSTEM_PROMPT).toContain('state why no suitable image is shown');
    });

    it('prevents decorative or misplaced research images', () => {
        expect(TOUCHAI_BUILTIN_SYSTEM_PROMPT).toContain('materially improves understanding');
        expect(TOUCHAI_BUILTIN_SYSTEM_PROMPT).toContain('software screenshots');
        expect(TOUCHAI_BUILTIN_SYSTEM_PROMPT).toContain(
            'include suitable Markdown images near related sections'
        );
        expect(TOUCHAI_BUILTIN_SYSTEM_PROMPT).toContain('avoid decorative logos');
        expect(TOUCHAI_BUILTIN_SYSTEM_PROMPT).toContain('generic hero art');
    });

    it('treats visuals as a default deliverable for source collection reports', () => {
        expect(TOUCHAI_BUILTIN_SYSTEM_PROMPT).toContain(
            'Treat useful visual evidence as a default deliverable'
        );
        expect(TOUCHAI_BUILTIN_SYSTEM_PROMPT).toContain('Actively look for software screenshots');
        expect(TOUCHAI_BUILTIN_SYSTEM_PROMPT).toContain(
            'include suitable Markdown images near related sections'
        );
    });

    it('requires a visual evidence workflow and final audit for research reports', () => {
        expect(TOUCHAI_BUILTIN_SYSTEM_PROMPT).toContain('run a visual audit');
        expect(TOUCHAI_BUILTIN_SYSTEM_PROMPT).toContain('state why no suitable image is shown');
    });

    it('encourages multiple high-value images when several report sections are visual', () => {
        expect(TOUCHAI_BUILTIN_SYSTEM_PROMPT).toContain('Use high-signal visuals only');
        expect(TOUCHAI_BUILTIN_SYSTEM_PROMPT).toContain('near the point it supports');
        expect(TOUCHAI_BUILTIN_SYSTEM_PROMPT).toContain('why it matters');
    });

    it('requires every embedded image to be explained and sourced in context', () => {
        expect(TOUCHAI_BUILTIN_SYSTEM_PROMPT).toContain('what it shows');
        expect(TOUCHAI_BUILTIN_SYSTEM_PROMPT).toContain('why it matters');
        expect(TOUCHAI_BUILTIN_SYSTEM_PROMPT).toContain('prefer original webpage images');
    });

    it('tells the model to reuse useful original images returned by web_fetch', () => {
        expect(TOUCHAI_BUILTIN_SYSTEM_PROMPT).toContain('web_fetch` article/original image');
        expect(TOUCHAI_BUILTIN_SYSTEM_PROMPT).toContain('Reuse useful Markdown image references');
        expect(TOUCHAI_BUILTIN_SYSTEM_PROMPT).toContain(
            'Use browser screenshots when original images are unavailable'
        );
    });
});
