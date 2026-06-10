import { describe, expect, it } from 'vitest';

import { TOUCHAI_BUILTIN_SYSTEM_PROMPT } from '@/services/AgentService/prompt/builtin';

describe('browser error attribution prompt guidance', () => {
    it('tells the model not to conflate local browser CDP failures with external web fetch failures', () => {
        expect(TOUCHAI_BUILTIN_SYSTEM_PROMPT).toContain(
            'Separate local browser startup/control failures'
        );
        expect(TOUCHAI_BUILTIN_SYSTEM_PROMPT).toContain('external website');
        expect(TOUCHAI_BUILTIN_SYSTEM_PROMPT).toContain('network, DNS, proxy, firewall');
    });

    it('guides source collection tasks toward authoritative visual reports', () => {
        expect(TOUCHAI_BUILTIN_SYSTEM_PROMPT).toContain(
            'Research, Source Collection, And Decision Support'
        );
        expect(TOUCHAI_BUILTIN_SYSTEM_PROMPT).toContain('official or primary sources');
        expect(TOUCHAI_BUILTIN_SYSTEM_PROMPT).toContain('other decisions');
        expect(TOUCHAI_BUILTIN_SYSTEM_PROMPT).toContain('original webpage images');
        expect(TOUCHAI_BUILTIN_SYSTEM_PROMPT).toContain('reference links');
    });

    it('requires a research plan before deep high-impact investigations', () => {
        expect(TOUCHAI_BUILTIN_SYSTEM_PROMPT).toContain('Scale depth to stakes');
        expect(TOUCHAI_BUILTIN_SYSTEM_PROMPT).toContain('need a plan');
        expect(TOUCHAI_BUILTIN_SYSTEM_PROMPT).toContain('multiple sources');
        expect(TOUCHAI_BUILTIN_SYSTEM_PROMPT).toContain('auditable detail');
    });

    it('matches research depth to topic stakes and keeps expanding evidence', () => {
        expect(TOUCHAI_BUILTIN_SYSTEM_PROMPT).toContain('Scale depth to stakes');
        expect(TOUCHAI_BUILTIN_SYSTEM_PROMPT).toContain('strategic');
        expect(TOUCHAI_BUILTIN_SYSTEM_PROMPT).toContain('search broadly');
        expect(TOUCHAI_BUILTIN_SYSTEM_PROMPT).toContain('separate facts from interpretation');
    });

    it('tells the model to use browser control when access is restricted', () => {
        expect(TOUCHAI_BUILTIN_SYSTEM_PROMPT).toContain('anti-bot/access friction');
        expect(TOUCHAI_BUILTIN_SYSTEM_PROMPT).toContain('Use `builtin__browser`');
    });

    it('requires visual evidence to be embedded when research images are available', () => {
        expect(TOUCHAI_BUILTIN_SYSTEM_PROMPT).toContain('Include useful visuals by default');
        expect(TOUCHAI_BUILTIN_SYSTEM_PROMPT).toContain('screenshots');
        expect(TOUCHAI_BUILTIN_SYSTEM_PROMPT).toContain('Markdown image references');
        expect(TOUCHAI_BUILTIN_SYSTEM_PROMPT).toContain('source attribution');
        expect(TOUCHAI_BUILTIN_SYSTEM_PROMPT).toContain('If suitable images are absent');
    });

    it('prevents decorative or misplaced research images', () => {
        expect(TOUCHAI_BUILTIN_SYSTEM_PROMPT).toContain('materially improves understanding');
        expect(TOUCHAI_BUILTIN_SYSTEM_PROMPT).toContain('screenshots');
        expect(TOUCHAI_BUILTIN_SYSTEM_PROMPT).toContain('near the claim it supports');
        expect(TOUCHAI_BUILTIN_SYSTEM_PROMPT).toContain('Use only high-signal visuals');
    });

    it('treats visuals as a default deliverable for source collection reports', () => {
        expect(TOUCHAI_BUILTIN_SYSTEM_PROMPT).toContain('Include useful visuals by default');
        expect(TOUCHAI_BUILTIN_SYSTEM_PROMPT).toContain('charts, maps, tables, or diagrams');
        expect(TOUCHAI_BUILTIN_SYSTEM_PROMPT).toContain('Put each image near the claim');
    });

    it('requires a visual evidence workflow and final audit for research reports', () => {
        expect(TOUCHAI_BUILTIN_SYSTEM_PROMPT).toContain('End web research with reference links');
        expect(TOUCHAI_BUILTIN_SYSTEM_PROMPT).toContain('If suitable images are absent');
    });

    it('encourages multiple high-value images when several report sections are visual', () => {
        expect(TOUCHAI_BUILTIN_SYSTEM_PROMPT).toContain('Use only high-signal visuals');
        expect(TOUCHAI_BUILTIN_SYSTEM_PROMPT).toContain('near the claim it supports');
        expect(TOUCHAI_BUILTIN_SYSTEM_PROMPT).toContain('explain its value');
    });

    it('requires every embedded image to be explained and sourced in context', () => {
        expect(TOUCHAI_BUILTIN_SYSTEM_PROMPT).toContain('explain its value');
        expect(TOUCHAI_BUILTIN_SYSTEM_PROMPT).toContain('source attribution');
        expect(TOUCHAI_BUILTIN_SYSTEM_PROMPT).toContain('prefer original webpage images');
    });

    it('tells the model to reuse useful original images returned by web_fetch', () => {
        expect(TOUCHAI_BUILTIN_SYSTEM_PROMPT).toContain('original webpage image candidates');
        expect(TOUCHAI_BUILTIN_SYSTEM_PROMPT).toContain('Reuse Markdown image references');
        expect(TOUCHAI_BUILTIN_SYSTEM_PROMPT).toContain('Use screenshots when page state');
    });
});
