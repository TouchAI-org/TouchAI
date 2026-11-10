import type { InvokeArgs } from '@tauri-apps/api/core';
import { installSkillCommands, skillFile, widgetSkillFile } from '@tests/utils/skills';
import { getTauriInvokeCalls, interceptTauriInvoke, mockTauriCommand } from '@tests/utils/tauri';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { setLocale } from '@/i18n';
import SkillsPanel from '@/views/SettingsView/components/Skills/SkillsPanel.vue';

let wrapper: VueWrapper;
async function open() {
    wrapper = mount(SkillsPanel, { attachTo: document.body });
    await flushPromises();
    return wrapper;
}
async function clickText(text: string) {
    const button = wrapper.findAll('button').find((button) => button.text().trim() === text);
    expect(button).toBeDefined();
    await button!.trigger('click');
    await flushPromises();
}
beforeEach(() => {
    setLocale('en-US');
    installSkillCommands([skillFile('alpha'), skillFile('beta', true)]);
});
afterEach(() => {
    wrapper?.unmount();
    document.body.innerHTML = '';
});

describe('given local skills are installed', () => {
    it.each([
        ['en-US', 'Global', 'App', 'Built-in'],
        ['zh-CN', '全局', '应用', '内置'],
    ] as const)(
        'user browses skills in %s and sees application, global, then built-in groups with alphabetized entries',
        async (locale, sharedLabel, appLabel, builtInLabel) => {
            setLocale(locale);
            installSkillCommands(
                [
                    skillFile('global-zebra'),
                    skillFile('app-zebra', false, 'app'),
                    skillFile('global-alpha'),
                    skillFile('app-alpha', false, 'app'),
                ],
                [widgetSkillFile()]
            );
            await open();
            const list = wrapper.get('[data-testid="settings-skills-list"]');
            expect(list.findAll('h3').map((heading) => heading.text())).toEqual([
                appLabel,
                sharedLabel,
                builtInLabel,
            ]);
            expect(
                list.findAll('section').map((group) =>
                    group
                        .findAll('button[aria-pressed] span.block')
                        .filter((_, index) => index % 2 === 0)
                        .map((name) => name.text())
                )
            ).toEqual([['app-alpha', 'app-zebra'], ['global-alpha', 'global-zebra'], ['widget']]);
            expect(list.find('[data-slot="skill-scope"]').exists()).toBe(false);
            for (const [name, label] of [
                ['global-alpha', sharedLabel],
                ['app-alpha', appLabel],
                ['widget', builtInLabel],
            ]) {
                const button = wrapper
                    .get('[data-testid="settings-skills-list"]')
                    .findAll('button[aria-pressed]')
                    .find((candidate) => candidate.text().includes(name!))!;
                expect(
                    button.element.closest('section')?.querySelector('h3')?.textContent
                ).toContain(label);
                await button.trigger('click');
                await flushPromises();
                expect(
                    wrapper.get('[data-testid="settings-skills-detail"] header').text()
                ).toContain(label);
            }
        }
    );
    it('user filters the catalog and sees only the groups containing matches', async () => {
        installSkillCommands(
            [skillFile('global-example'), skillFile('app-example', false, 'app')],
            [widgetSkillFile()]
        );
        await open();
        await wrapper.get('input[aria-label="Search skills"]').setValue('app-example');
        const list = wrapper.get('[data-testid="settings-skills-list"]');
        expect(list.findAll('h3').map((heading) => heading.text())).toEqual(['App']);
        expect(list.findAll('button[aria-pressed]')).toHaveLength(1);
        await wrapper.get('input[aria-label="Search skills"]').setValue('no-such-skill');
        expect(list.findAll('h3')).toHaveLength(0);
    });
    it('user given a bundled skill when opening settings then sees its built-in label and read-only content', async () => {
        installSkillCommands([], [widgetSkillFile()]);
        await open();
        expect(wrapper.get('[data-testid="settings-skills-list"]').text()).toContain('Built-in');
        expect(wrapper.get('[data-testid="settings-skills-detail"]').text()).toContain('Built-in');
        expect(wrapper.get('pre').text()).toContain('builtin__show_widget');
        expect(wrapper.find('[role="switch"]').exists()).toBe(false);
        expect(wrapper.find('[data-testid="settings-skills-delete"]').exists()).toBe(false);
        expect(wrapper.find('[data-testid="settings-skills-open-directory"]').exists()).toBe(false);
    });
    it('user sees the selected skill content alongside its details when searching the catalog', async () => {
        await open();
        const detail = wrapper.get('[data-testid="settings-skills-detail"]');
        expect(detail.get('h2').text()).toBe('alpha');
        expect(detail.get('pre').text()).toContain('Private alpha instructions');
        expect(wrapper.find('[role="tablist"]').exists()).toBe(false);
        expect(
            wrapper
                .findAll('button')
                .filter((button) => ['Overview', 'Content'].includes(button.text()))
        ).toHaveLength(0);
        await wrapper.get('input[aria-label="Search skills"]').setValue('beta');
        const list = wrapper.get('[data-testid="settings-skills-list"]');
        expect(list.text()).toContain('beta');
        expect(list.text()).not.toContain('alpha');
        await list.get('button[aria-pressed]').trigger('click');
        await flushPromises();
        expect(wrapper.get('pre').text()).toContain('Private beta instructions');
    });
    it.each([
        ['en-US', 'Open containing folder', 'Delete skill'],
        ['zh-CN', '打开所在文件夹', '删除技能'],
    ] as const)(
        'user finds labeled icon-only folder and delete actions in the detail header when using %s',
        async (locale, folderLabel, deleteLabel) => {
            setLocale(locale);
            await open();

            const detail = wrapper.get('[data-testid="settings-skills-detail"]');
            const header = detail.get('header');
            expect(header.get('h2').text()).toBe('alpha');
            expect(header.findAll('button')).toHaveLength(2);
            for (const label of [folderLabel, deleteLabel]) {
                const button = header.get(`button[aria-label="${label}"]`);
                expect(button.text()).toBe('');
                expect(button.attributes('title')).toBe(label);
                expect(button.find('svg').exists()).toBe(true);
            }
            expect(detail.text()).not.toContain(skillFile('alpha').path);
            expect(detail.find('footer').exists()).toBe(false);
        }
    );
    it('user has one enable switch per skill in the list when changing the selection', async () => {
        await open();
        const list = wrapper.get('[data-testid="settings-skills-list"]');
        expect(wrapper.findAll('[role="switch"]')).toHaveLength(2);
        expect(
            list.get('[data-testid="settings-skills-toggle-disabled"]').attributes('aria-label')
        ).toBe('Disable alpha');
        expect(wrapper.findAll('h2').map((heading) => heading.text())).toEqual(['alpha']);

        const beta = list
            .findAll('button[aria-pressed]')
            .find((button) => button.text().includes('beta'))!;
        await beta.trigger('click');
        expect(
            list.get('[data-testid="settings-skills-toggle-disabled"]').attributes('aria-label')
        ).toBe('Enable beta');
        expect(wrapper.get('[data-testid="settings-skills-detail"]').get('h2').text()).toBe('beta');
    });
    it('user given long skill descriptions when opening details then reads them in the content without a duplicate header summary', async () => {
        const description = `Detailed alpha guidance. ${'More context. '.repeat(50)}Overview tail.`;
        const shortDescription = `Alpha summary. ${'More summary. '.repeat(20)}Summary tail.`;
        const frontmatter = `---\nname: alpha\ndescription: ${JSON.stringify(description)}\nmetadata:\n  short-description: ${JSON.stringify(shortDescription)}\n---\n`;
        installSkillCommands([
            {
                ...skillFile('alpha'),
                frontmatter,
                content: `${frontmatter}# Private alpha instructions`,
            },
        ]);

        await open();
        const list = wrapper.get('[data-testid="settings-skills-list"]');
        const detail = wrapper.get('[data-testid="settings-skills-detail"]');
        expect(list.text()).toContain('Alpha summary.');
        expect(list.text()).toContain('...');
        expect(list.text()).not.toContain('Summary tail.');
        expect(detail.get('header').text()).not.toContain('Detailed alpha guidance.');

        expect(detail.get('pre').text()).toContain(description);
        expect(detail.get('pre').text()).toContain(shortDescription);
    });
    it('user finds a skill by omitted description text when its list summary is shortened', async () => {
        const description = `Alpha document helper. ${'More guidance. '.repeat(40)}Needle at the end.`;
        installSkillCommands([
            {
                ...skillFile('alpha'),
                frontmatter: `---\nname: alpha\ndescription: ${JSON.stringify(description)}\n---\n`,
            },
            skillFile('beta'),
        ]);

        await open();
        await wrapper.get('input[aria-label="Search skills"]').setValue('needle at the end');
        const list = wrapper.get('[data-testid="settings-skills-list"]');
        expect(list.text()).toContain('alpha');
        expect(list.text()).toContain('Alpha document helper.');
        expect(list.text()).toContain('...');
        expect(list.text()).not.toContain('Needle at the end.');
        expect(list.text()).not.toContain('beta');
    });
    it('user disables a skill and the state remains disabled after refresh', async () => {
        await open();
        await wrapper.get('[data-testid="settings-skills-toggle-disabled"]').trigger('click');
        await flushPromises();
        expect(wrapper.get('[aria-label="Enable alpha"]').attributes('aria-checked')).toBe('false');
        await wrapper.get('[aria-label="Refresh skills"]').trigger('click');
        await flushPromises();
        expect(
            wrapper
                .get('[data-testid="settings-skills-toggle-disabled"]')
                .attributes('aria-checked')
        ).toBe('false');
    });
    it('user updates another skill independently while the first skill is still saving', async () => {
        let finishAlpha!: () => void;
        const alphaUpdate = new Promise<void>((resolve) => {
            finishAlpha = resolve;
        });
        interceptTauriInvoke(async ({ cmd, payload }, next) => {
            if (
                cmd === 'agent_skills_set_user_skill_disabled' &&
                (payload as { path: string }).path === skillFile('alpha').path
            ) {
                await alphaUpdate;
            }
            return next();
        });

        await open();
        await wrapper.get('[aria-label="Disable alpha"]').trigger('click');
        expect(
            wrapper.get<HTMLButtonElement>('[aria-label="Disable alpha"]').element.disabled
        ).toBe(true);
        expect(wrapper.get<HTMLButtonElement>('[aria-label="Enable beta"]').element.disabled).toBe(
            false
        );
        expect(
            wrapper.get<HTMLButtonElement>('[data-testid="settings-skills-delete"]').element
                .disabled
        ).toBe(true);

        await wrapper.get('[aria-label="Enable beta"]').trigger('click');
        await flushPromises();
        expect(wrapper.get('[aria-label="Disable beta"]').attributes('aria-checked')).toBe('true');
        expect(wrapper.get<HTMLButtonElement>('[aria-label="Disable beta"]').element.disabled).toBe(
            false
        );
        expect(
            wrapper.get<HTMLButtonElement>('[aria-label="Disable alpha"]').element.disabled
        ).toBe(true);
        const beta = wrapper
            .findAll('button[aria-pressed]')
            .find((button) => button.text().includes('beta'))!;
        await beta.trigger('click');
        expect(
            wrapper.get<HTMLButtonElement>('[data-testid="settings-skills-delete"]').element
                .disabled
        ).toBe(false);

        finishAlpha();
        await flushPromises();
        expect(wrapper.get('[aria-label="Enable alpha"]').attributes('aria-checked')).toBe('false');
        expect(wrapper.get<HTMLButtonElement>('[aria-label="Enable alpha"]').element.disabled).toBe(
            false
        );
        await wrapper.get('[aria-label="Refresh skills"]').trigger('click');
        await flushPromises();
        expect(wrapper.get('[aria-label="Enable alpha"]').attributes('aria-checked')).toBe('false');
        expect(wrapper.get('[aria-label="Disable beta"]').attributes('aria-checked')).toBe('true');
    });
    it('user keeps the enabled state and can retry when a status update fails', async () => {
        mockTauriCommand('agent_skills_set_user_skill_disabled', () => {
            throw new Error('Denied');
        });
        await open();
        await wrapper.get('[data-testid="settings-skills-toggle-disabled"]').trigger('click');
        await flushPromises();
        expect(wrapper.get('[role="alert"]').text()).toContain('Unable to update');
        expect(
            wrapper
                .get('[data-testid="settings-skills-toggle-disabled"]')
                .attributes('aria-checked')
        ).toBe('true');
        expect(
            wrapper.get<HTMLButtonElement>('[aria-label="Disable alpha"]').element.disabled
        ).toBe(false);
        expect(wrapper.get<HTMLButtonElement>('[aria-label="Enable beta"]').element.disabled).toBe(
            false
        );

        installSkillCommands([skillFile('alpha'), skillFile('beta', true)]);
        await wrapper.get('[aria-label="Disable alpha"]').trigger('click');
        await flushPromises();
        expect(wrapper.find('[role="alert"]').exists()).toBe(false);
        expect(wrapper.get('[aria-label="Enable alpha"]').attributes('aria-checked')).toBe('false');
    });
    it('user retries a content read after a filesystem error', async () => {
        mockTauriCommand('agent_skills_read_user_file', () => {
            throw new Error('Denied');
        });
        await open();
        expect(wrapper.text()).toContain('Unable to read');
        mockTauriCommand('agent_skills_read_user_file', '# Recovered');
        await clickText('Retry');
        expect(wrapper.get('pre').text()).toBe('# Recovered');
    });
    it('user sees the content loading state until the requested file is ready', async () => {
        let resolve!: (value: string) => void;
        mockTauriCommand(
            'agent_skills_read_user_file',
            () => new Promise<string>((done) => (resolve = done))
        );
        await open();

        const content = wrapper.get('[data-testid="settings-skills-content"]');
        expect(content.attributes('aria-busy')).toBe('true');
        expect(content.get('[role="status"]').attributes('aria-label')).toBe(
            'Loading skill content…'
        );
        expect(content.find('pre').exists()).toBe(false);
        expect(wrapper.get('[data-testid="settings-skills-list"]').text()).toContain('alpha');

        resolve('# Ready alpha instructions');
        await flushPromises();
        expect(content.attributes('aria-busy')).toBe('false');
        expect(content.find('[role="status"]').exists()).toBe(false);
        expect(content.get('pre').text()).toBe('# Ready alpha instructions');
    });
    it('user never sees an earlier selection overwrite the current skill content', async () => {
        let resolve!: (value: string) => void;
        const slow = new Promise<string>((done) => {
            resolve = done;
        });
        mockTauriCommand('agent_skills_read_user_file', (args?: InvokeArgs) =>
            (args as { path: string }).path.includes('/alpha/') ? slow : '# Beta'
        );
        await open();
        const beta = wrapper
            .findAll('button[aria-pressed]')
            .find((button) => button.text().includes('beta'))!;
        await beta.trigger('click');
        await flushPromises();
        expect(wrapper.get('pre').text()).toBe('# Beta');
        resolve('# Alpha');
        await flushPromises();
        expect(wrapper.get('pre').text()).toBe('# Beta');
    });
    it('user given a selected skill when opening its folder then opens that skill directory', async () => {
        await open();
        await wrapper.get('[data-testid="settings-skills-open-directory"]').trigger('click');
        expect(getTauriInvokeCalls('agent_skills_open_user_directory')[0]?.payload).toEqual({
            directory: skillFile('alpha').directory,
        });
    });
    it('user sees a folder error while keeping the selected skill available', async () => {
        mockTauriCommand('agent_skills_open_user_directory', () => {
            throw new Error('Denied');
        });
        await open();
        await wrapper.get('[data-testid="settings-skills-open-directory"]').trigger('click');
        await flushPromises();
        expect(wrapper.get('[role="alert"]').text()).toContain('Unable to open');
        expect(wrapper.get('[data-testid="settings-skills-detail"]').text()).toContain('alpha');
    });
    it('user confirms deletion of the selected folder and sees the next skill', async () => {
        await open();
        await wrapper.get('[data-testid="settings-skills-delete"]').trigger('click');
        await flushPromises();
        const dialog = document.querySelector('[role="alertdialog"], [role="dialog"]');
        expect(dialog?.textContent).toContain('Delete alpha?');
        expect(dialog?.textContent).toContain(skillFile('alpha').directory);
        expect(getTauriInvokeCalls('agent_skills_delete_user_directory')).toEqual([]);
        const confirm = Array.from(dialog!.querySelectorAll('button')).find(
            (button) => button.textContent?.trim() === 'Delete skill'
        )!;
        confirm.click();
        await flushPromises();
        expect(wrapper.get('[data-testid="settings-skills-list"]').text()).not.toContain('alpha');
        expect(wrapper.text()).toContain('beta');
        await wrapper.get('[aria-label="Refresh skills"]').trigger('click');
        await flushPromises();
        expect(wrapper.get('[data-testid="settings-skills-list"]').text()).not.toContain('alpha');
    });
    it('user cancels deletion without losing the selected skill', async () => {
        await open();
        await wrapper.get('[data-testid="settings-skills-delete"]').trigger('click');
        await flushPromises();
        const cancel = Array.from(
            document.querySelectorAll('[role="alertdialog"] button, [role="dialog"] button')
        ).find((button) => button.textContent?.trim() === 'Cancel') as HTMLButtonElement;
        cancel.click();
        await flushPromises();
        expect(wrapper.text()).toContain('alpha');
        expect(getTauriInvokeCalls('agent_skills_delete_user_directory')).toEqual([]);
    });
});

describe('given discovery takes time to finish', () => {
    it('user sees page loading in place of the list and details until discovery finishes', async () => {
        let resolve!: (value: ReturnType<typeof skillFile>[]) => void;
        mockTauriCommand(
            'agent_skills_discover_user_files',
            () => new Promise<ReturnType<typeof skillFile>[]>((done) => (resolve = done))
        );

        await open();
        expect(wrapper.find('[data-testid="settings-skills-list"]').exists()).toBe(false);
        expect(wrapper.find('main').exists()).toBe(false);
        expect(wrapper.find('input').exists()).toBe(false);
        expect(wrapper.get('[role="status"]').attributes('aria-label')).toBe('Loading skills…');
        expect(wrapper.attributes('aria-busy')).toBe('true');

        resolve([skillFile('alpha')]);
        await flushPromises();
        expect(wrapper.find('[role="status"]').exists()).toBe(false);
        expect(wrapper.attributes('aria-busy')).toBe('false');
        expect(wrapper.get('[data-testid="settings-skills-detail"]').text()).toContain('alpha');
    });
    it('user keeps the selected rows, instructions, and scroll positions while refresh completes quietly', async () => {
        await open();
        const beta = wrapper
            .findAll('button[aria-pressed]')
            .find((button) => button.text().includes('beta'))!;
        await beta.trigger('click');
        await flushPromises();
        const list = wrapper.get<HTMLElement>('[data-testid="settings-skills-list"]').element;
        const detail = wrapper.get<HTMLElement>('[data-testid="settings-skills-content"]').element;
        list.scrollTop = 80;
        detail.scrollTop = 160;

        let finishDiscovery!: (value: ReturnType<typeof skillFile>[]) => void;
        let finishContent!: (value: string) => void;
        mockTauriCommand(
            'agent_skills_discover_user_files',
            () => new Promise<ReturnType<typeof skillFile>[]>((done) => (finishDiscovery = done))
        );
        mockTauriCommand(
            'agent_skills_read_user_file',
            () => new Promise<string>((done) => (finishContent = done))
        );

        await wrapper.get('[aria-label="Refresh skills"]').trigger('click');
        expect(wrapper.get('[data-testid="settings-skills-list"]').element).toBe(list);
        expect(wrapper.get('[data-testid="settings-skills-content"]').element).toBe(detail);
        expect(wrapper.get('pre').text()).toContain('Private beta instructions');
        expect(wrapper.get('[role="status"]').attributes('aria-label')).toBe('Refreshing skills…');
        expect(wrapper.get('[aria-label="Refresh skills"]').attributes('aria-busy')).toBe('true');
        expect(wrapper.attributes('aria-busy')).toBe('false');
        expect(list.scrollTop).toBe(80);
        expect(detail.scrollTop).toBe(160);

        finishDiscovery([skillFile('alpha', true), skillFile('beta')]);
        await flushPromises();
        expect(wrapper.get('h2').text()).toBe('beta');
        expect(wrapper.get('pre').text()).toContain('Private beta instructions');
        expect(wrapper.get('[data-testid="settings-skills-content"]').attributes('aria-busy')).toBe(
            'true'
        );
        expect(list.scrollTop).toBe(80);
        expect(detail.scrollTop).toBe(160);

        finishContent('# Refreshed beta instructions');
        await flushPromises();
        expect(wrapper.find('[role="status"]').exists()).toBe(false);
        expect(wrapper.get('[aria-label="Refresh skills"]').attributes('aria-busy')).toBe('false');
        expect(wrapper.get('pre').text()).toBe('# Refreshed beta instructions');
        expect(
            wrapper
                .get('[data-testid="settings-skills-toggle-disabled"]')
                .attributes('aria-checked')
        ).toBe('true');
        expect(wrapper.get('[data-testid="settings-skills-list"]').element).toBe(list);
        expect(wrapper.get('[data-testid="settings-skills-content"]').element).toBe(detail);
        expect(list.scrollTop).toBe(80);
        expect(detail.scrollTop).toBe(160);
    });
    it('user recovers the previous selection and content when refresh fails', async () => {
        await open();
        await wrapper.get('input[aria-label="Search skills"]').setValue('beta');
        await wrapper
            .get('[data-testid="settings-skills-list"] button[aria-pressed]')
            .trigger('click');
        await flushPromises();
        const detail = wrapper.get<HTMLElement>('[data-testid="settings-skills-content"]').element;
        detail.scrollTop = 160;
        let reject!: (reason: Error) => void;
        mockTauriCommand(
            'agent_skills_discover_user_files',
            () => new Promise((_, fail) => (reject = fail))
        );

        await wrapper.get('[aria-label="Refresh skills"]').trigger('click');
        expect(wrapper.get('[data-testid="settings-skills-list"]').text()).toContain('beta');
        expect(wrapper.get('pre').text()).toContain('Private beta instructions');
        expect(wrapper.get('[role="status"]').attributes('aria-label')).toBe('Refreshing skills…');

        reject(new Error('Denied'));
        await flushPromises();
        expect(wrapper.get('[role="alert"]').text()).toContain('Unable to load skills');
        expect(wrapper.find('[role="status"]').exists()).toBe(false);
        expect(
            wrapper.get<HTMLInputElement>('input[aria-label="Search skills"]').element.value
        ).toBe('beta');
        expect(wrapper.get('pre').text()).toContain('Private beta instructions');
        expect(wrapper.get('[data-testid="settings-skills-content"]').element).toBe(detail);
        expect(detail.scrollTop).toBe(160);
        expect(
            wrapper.get('[data-testid="settings-skills-toggle-disabled"]').attributes('aria-label')
        ).toBe('Enable beta');

        installSkillCommands([skillFile('alpha'), skillFile('beta', true)]);
        await wrapper.get('[aria-label="Refresh skills"]').trigger('click');
        await flushPromises();
        expect(wrapper.find('[role="alert"]').exists()).toBe(false);
        expect(wrapper.get('pre').text()).toContain('Private beta instructions');
    });
    it('user keeps loaded instructions and can retry when refreshed content cannot be read', async () => {
        await open();
        mockTauriCommand('agent_skills_read_user_file', () => {
            throw new Error('Denied');
        });

        await wrapper.get('[aria-label="Refresh skills"]').trigger('click');
        await flushPromises();
        expect(wrapper.get('pre').text()).toContain('Private alpha instructions');
        expect(wrapper.get('[role="alert"]').text()).toContain('Unable to read skill content');
        expect(wrapper.get('[aria-label="Refresh skills"]').attributes('aria-busy')).toBe('false');

        mockTauriCommand('agent_skills_read_user_file', '# Recovered instructions');
        await clickText('Retry');
        expect(wrapper.get('pre').text()).toBe('# Recovered instructions');
        expect(wrapper.find('[role="alert"]').exists()).toBe(false);
    });
    it('user keeps a completed status change when an older refresh result arrives', async () => {
        await open();
        let finishDiscovery!: (value: ReturnType<typeof skillFile>[]) => void;
        mockTauriCommand(
            'agent_skills_discover_user_files',
            () => new Promise<ReturnType<typeof skillFile>[]>((done) => (finishDiscovery = done))
        );

        await wrapper.get('[aria-label="Refresh skills"]').trigger('click');
        await wrapper.get('[aria-label="Disable alpha"]').trigger('click');
        await flushPromises();
        expect(wrapper.get('[aria-label="Enable alpha"]').attributes('aria-checked')).toBe('false');

        finishDiscovery([skillFile('alpha'), skillFile('beta', true)]);
        await flushPromises();
        expect(wrapper.get('[aria-label="Enable alpha"]').attributes('aria-checked')).toBe('false');
        expect(wrapper.get('pre').text()).toContain('Private alpha instructions');
    });
    it('user keeps a confirmed deletion when an older refresh result arrives', async () => {
        await open();
        let finishDiscovery!: (value: ReturnType<typeof skillFile>[]) => void;
        mockTauriCommand(
            'agent_skills_discover_user_files',
            () => new Promise<ReturnType<typeof skillFile>[]>((done) => (finishDiscovery = done))
        );

        await wrapper.get('[aria-label="Refresh skills"]').trigger('click');
        await wrapper.get('[data-testid="settings-skills-delete"]').trigger('click');
        await flushPromises();
        const dialog = document.querySelector('[role="alertdialog"], [role="dialog"]');
        const confirm = Array.from(dialog!.querySelectorAll('button')).find(
            (button) => button.textContent?.trim() === 'Delete skill'
        )!;
        confirm.click();
        await flushPromises();
        expect(wrapper.get('[data-testid="settings-skills-list"]').text()).not.toContain('alpha');

        finishDiscovery([skillFile('alpha'), skillFile('beta', true)]);
        await flushPromises();
        expect(wrapper.get('[data-testid="settings-skills-list"]').text()).not.toContain('alpha');
        expect(wrapper.get('h2').text()).toBe('beta');
        expect(wrapper.get('pre').text()).toContain('Private beta instructions');
    });
});

describe('given the skills folder is empty or temporarily unavailable', () => {
    it('user given an empty skills catalog when opening settings then sees an empty state and can refresh', async () => {
        installSkillCommands([]);
        await open();
        expect(wrapper.text()).toContain('No skills yet');
        expect(wrapper.find('[aria-label="Refresh skills"]').exists()).toBe(true);
    });
    it('user retries discovery after a filesystem error', async () => {
        mockTauriCommand('agent_skills_discover_user_files', () => {
            throw new Error('Denied');
        });
        await open();
        expect(wrapper.text()).toContain('Unable to load');
        installSkillCommands();
        await clickText('Retry');
        expect(wrapper.text()).toContain('summary');
    });
});
