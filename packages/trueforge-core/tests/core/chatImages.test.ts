import { isTrackingImageLink } from '../../src/core/chatImages';

describe('isTrackingImageLink', () => {
  it('names open-tracking pixels by host or by path', () => {
    expect(isTrackingImageLink('https://news.list-manage.com/track/open.php?u=abc')).toBe(true);
    expect(isTrackingImageLink('https://u1.ct.sendgrid.net/wf/open?upn=xyz')).toBe(true);
    expect(isTrackingImageLink('https://mail.example.com/o/pixel.gif')).toBe(true);
    expect(isTrackingImageLink('https://example.com/t/open')).toBe(true);
  });

  it('keeps ordinary pictures and links it cannot read', () => {
    expect(isTrackingImageLink('https://example.com/banner.png')).toBe(false);
    expect(isTrackingImageLink('https://example.com/pixel-art/cat.png')).toBe(false);
    expect(isTrackingImageLink('not a link')).toBe(false);
  });
});
