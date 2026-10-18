# frozen_string_literal: true

# Keep the upstream Chatwoot database and authentication behavior untouched.
# Tenant-facing branding is overlaid at the global-config boundary so an
# upstream image upgrade only needs this small adapter to be replayed.
require Rails.root.join('lib/global_config').to_s

module ReplyNestBranding
  VALUES = {
    'INSTALLATION_NAME' => '答巢 ReplyNest',
    'BRAND_NAME' => '答巢 ReplyNest',
    'BRAND_URL' => 'https://replynest.cn/',
    'WIDGET_BRAND_URL' => 'https://replynest.cn/',
    'LOGO' => '/replynest-brand-cn.png',
    'LOGO_DARK' => '/replynest-brand-cn.png',
    'LOGO_THUMBNAIL' => '/replynest-mark.png',
    'TERMS_URL' => 'https://replynest.cn/legal/terms',
    'PRIVACY_URL' => 'https://replynest.cn/legal/privacy'
  }.freeze

  def get(*args)
    requested = args.flatten.map(&:to_s)
    super.tap do |config|
      VALUES.each { |key, value| config[key] = value if requested.include?(key) }
    end
  end

  def get_value(key)
    VALUES.fetch(key.to_s) { super }
  end
end

GlobalConfig.singleton_class.prepend(ReplyNestBranding)
