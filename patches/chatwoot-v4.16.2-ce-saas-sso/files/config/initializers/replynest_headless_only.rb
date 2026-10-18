# Block the legacy browser entry even when bypassing the public proxy or using an old session.
# Internal account APIs, widget/public APIs and visitor ActionCable remain untouched.
class ReplynestHeadlessOnly
  def initialize(app); @app = app; end
  def call(env)
    path = env['PATH_INFO'].to_s
    if path == '/' || %w[/app /auth /installation].any? { |prefix| path == prefix || path.start_with?(prefix + '/') }
      return [303, { 'location' => 'https://console.replynest.cn/workbench', 'cache-control' => 'no-store', 'content-type' => 'text/plain' }, ['Please use ReplyNest workspace']]
    end
    @app.call(env)
  end
end
Rails.application.config.middleware.insert_before 0, ReplynestHeadlessOnly
