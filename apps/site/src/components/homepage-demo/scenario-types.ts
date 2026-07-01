export type HomepageDemoScenarioId = 'intro' | 'solver' | 'work-organizer' | 'reminder';

export type HomepageDemoReplayScenarioId = Exclude<HomepageDemoScenarioId, 'intro'>;
