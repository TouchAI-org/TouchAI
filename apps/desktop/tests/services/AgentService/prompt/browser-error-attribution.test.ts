import { describe, expect, it } from 'vitest';

import { TOUCHAI_BUILTIN_SYSTEM_PROMPT } from '@/services/AgentService/prompt/builtin';

describe('user gets accurate explanations when the assistant browses', () => {
    it('user is not told a local browser failure was a web fetch failure', () => {
        expect(TOUCHAI_BUILTIN_SYSTEM_PROMPT).toContain(
            'Separate local browser startup/control failures'
        );
        expect(TOUCHAI_BUILTIN_SYSTEM_PROMPT).toContain('external website');
        expect(TOUCHAI_BUILTIN_SYSTEM_PROMPT).toContain('network, DNS, proxy, firewall');
    });

    it('user gets an authoritative visual report when sources are collected', () => {
        expect(TOUCHAI_BUILTIN_SYSTEM_PROMPT).toContain(
            'Research, Source Collection, And Decision Support'
        );
        expect(TOUCHAI_BUILTIN_SYSTEM_PROMPT).toContain('official or primary sources');
        expect(TOUCHAI_BUILTIN_SYSTEM_PROMPT).toContain('other decisions');
        expect(TOUCHAI_BUILTIN_SYSTEM_PROMPT).toContain('original webpage images');
        expect(TOUCHAI_BUILTIN_SYSTEM_PROMPT).toContain('reference links');
    });

    it('user gets a research plan before deep high-impact investigations', () => {
        expect(TOUCHAI_BUILTIN_SYSTEM_PROMPT).toContain('Scale depth to stakes');
        expect(TOUCHAI_BUILTIN_SYSTEM_PROMPT).toContain('need a plan');
        expect(TOUCHAI_BUILTIN_SYSTEM_PROMPT).toContain('multiple sources');
        expect(TOUCHAI_BUILTIN_SYSTEM_PROMPT).toContain('auditable detail');
    });

    it('user sees research depth matched to the stakes with evidence kept expanding', () => {
        expect(TOUCHAI_BUILTIN_SYSTEM_PROMPT).toContain('Scale depth to stakes');
        expect(TOUCHAI_BUILTIN_SYSTEM_PROMPT).toContain('strategic');
        expect(TOUCHAI_BUILTIN_SYSTEM_PROMPT).toContain('search broadly');
        expect(TOUCHAI_BUILTIN_SYSTEM_PROMPT).toContain('separate facts from interpretation');
    });

    it('user sees browser control used when a site restricts access', () => {
        expect(TOUCHAI_BUILTIN_SYSTEM_PROMPT).toContain('anti-bot/access friction');
        expect(TOUCHAI_BUILTIN_SYSTEM_PROMPT).toContain('Use `builtin__browser`');
    });

    it('user sees available research images embedded as visual evidence', () => {
        expect(TOUCHAI_BUILTIN_SYSTEM_PROMPT).toContain('Include useful visuals by default');
        expect(TOUCHAI_BUILTIN_SYSTEM_PROMPT).toContain('screenshots');
        expect(TOUCHAI_BUILTIN_SYSTEM_PROMPT).toContain('Markdown image references');
        expect(TOUCHAI_BUILTIN_SYSTEM_PROMPT).toContain('source attribution');
        expect(TOUCHAI_BUILTIN_SYSTEM_PROMPT).toContain('If suitable images are absent');
    });

    it('user sees no decorative or misplaced research images', () => {
        expect(TOUCHAI_BUILTIN_SYSTEM_PROMPT).toContain('materially improves understanding');
        expect(TOUCHAI_BUILTIN_SYSTEM_PROMPT).toContain('screenshots');
        expect(TOUCHAI_BUILTIN_SYSTEM_PROMPT).toContain('near the claim it supports');
        expect(TOUCHAI_BUILTIN_SYSTEM_PROMPT).toContain('Use only high-signal visuals');
    });

    it('user sees visuals treated as a default deliverable for source collection', () => {
        expect(TOUCHAI_BUILTIN_SYSTEM_PROMPT).toContain('Include useful visuals by default');
        expect(TOUCHAI_BUILTIN_SYSTEM_PROMPT).toContain('charts, maps, tables, or diagrams');
        expect(TOUCHAI_BUILTIN_SYSTEM_PROMPT).toContain('Put each image near the claim');
    });

    it('user sees a visual evidence workflow and final audit in research reports', () => {
        expect(TOUCHAI_BUILTIN_SYSTEM_PROMPT).toContain('End web research with reference links');
        expect(TOUCHAI_BUILTIN_SYSTEM_PROMPT).toContain('If suitable images are absent');
    });

    it('user sees several high-value images when report sections are visual', () => {
        expect(TOUCHAI_BUILTIN_SYSTEM_PROMPT).toContain('Use only high-signal visuals');
        expect(TOUCHAI_BUILTIN_SYSTEM_PROMPT).toContain('near the claim it supports');
        expect(TOUCHAI_BUILTIN_SYSTEM_PROMPT).toContain('explain its value');
    });

    it('user sees every embedded image explained and sourced in context', () => {
        expect(TOUCHAI_BUILTIN_SYSTEM_PROMPT).toContain('explain its value');
        expect(TOUCHAI_BUILTIN_SYSTEM_PROMPT).toContain('source attribution');
        expect(TOUCHAI_BUILTIN_SYSTEM_PROMPT).toContain('prefer original webpage images');
    });

    it('user sees useful original images from a fetched page reused', () => {
        expect(TOUCHAI_BUILTIN_SYSTEM_PROMPT).toContain('original webpage image candidates');
        expect(TOUCHAI_BUILTIN_SYSTEM_PROMPT).toContain('Reuse Markdown image references');
        expect(TOUCHAI_BUILTIN_SYSTEM_PROMPT).toContain('Use screenshots when page state');
    });
});
