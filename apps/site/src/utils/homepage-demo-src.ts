import {
    homepageDemoScenarios,
    type HomepageDemoLocale,
    type HomepageDemoScenarioId,
} from '../data/homepage-demo-scenarios';

export const getHomepageDemoVariant = (
    scenarioId: HomepageDemoScenarioId,
    locale: HomepageDemoLocale
) => homepageDemoScenarios[scenarioId].variants[locale];

export const getHomepageDemoSrc = (
    scenarioId: HomepageDemoScenarioId,
    locale: HomepageDemoLocale
) => getHomepageDemoVariant(scenarioId, locale).src;

export const getHomepageDemoTitle = (
    scenarioId: HomepageDemoScenarioId,
    locale: HomepageDemoLocale
) => getHomepageDemoVariant(scenarioId, locale).title;
