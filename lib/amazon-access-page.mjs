import { load } from 'cheerio';

// Shared by HTTP parsing and browser navigation; helper scripts alone are not a CAPTCHA.
export function detectAmazonAccessPage(source, $ = load(source), title = $("title").first().text().trim()) {
  const rendered = $.root().clone();
  rendered.find('script, style, template, noscript, [hidden], [aria-hidden="true"]').remove();
  rendered.find('[style]').filter((_index, element) => /(?:display\s*:\s*none|visibility\s*:\s*hidden)/i.test($(element).attr('style') || '')).remove();
  const visibleText = rendered.text().replace(/\s+/g, ' ').trim();
  const hasProducts = Boolean(rendered.find('#productTitle').text().trim())
    || rendered.find('[data-component-type="s-search-result"][data-asin]').toArray()
      .some(element => /^[A-Z0-9]{10}$/i.test($(element).attr('data-asin') || ''));
  const hasStoreContent = /\b(?:no results|0 results|did not match any products)\b|geen (?:zoek)?resultaten|geen producten gevonden|leverde geen resultaten op/i.test(rendered.find('#search').text());
  const hasCommerceContent = hasProducts || hasStoreContent;
  const challengeForm = rendered.find('form[action]').toArray().some(element =>
    /\/(?:errors\/validatecaptcha|ap\/cvf|_sec\/verify)(?:[/?#]|$)/i.test($(element).attr('action') || ''));
  const challengeInput = rendered.find('#captchacharacters, input[name="captchacharacters"]').length > 0;
  const challengeContainer = rendered.find('#challenge-container, .challenge-container, #captcha-container').length > 0;
  const challengeTitle = /^(?:amazon\s*[-:]?\s*)?robot check$/i.test(title);
  const challengeText = /automated[-\s]+access|robot check|enter the characters you see below|api-services-support@amazon\.com|unusual activity|(?:make sure|verify) (?:that )?you(?:'|’)?re not a robot/i.test(visibleText);
  const challengeBootstrap = /\/(?:_sec\/verify|errors\/validatecaptcha|ap\/cvf)\b|bm-verify|awswaf\.com|AwsWafIntegration|window\.gokuProps/i.test(source);
  const rateLimited = /^\s*429(?:\s|-|:)/i.test(title)
    || (!hasCommerceContent && /(?:\b429\b.{0,80}\btoo many requests\b|\btoo many requests\b.{0,80}\b429\b|request (?:rate )?limit(?:ed)?|temporarily rate limited)/i.test(visibleText));
  const challenge = challengeForm || challengeInput || challengeContainer || challengeTitle
    || (!hasProducts && challengeText) || (!hasCommerceContent && challengeBootstrap);
  return { rateLimited, challenge, reason: challengeForm ? 'verification_form' : challengeInput ? 'captcha_input'
    : challengeContainer ? 'challenge_container' : challengeTitle ? 'robot_check_title'
      : !hasProducts && challengeText ? 'verification_text' : !hasCommerceContent && challengeBootstrap ? 'challenge_interstitial' : null };
}
