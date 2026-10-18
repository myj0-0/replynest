require 'net/http'
require 'openssl'
require 'securerandom'

class ReplynestReceptionOutbox < ApplicationRecord
  # Called inside Message's creation transaction: no HTTP/Redis dependency here.
  def self.capture(message)
    return unless ENV['REPLYNEST_RECEPTION_BRIDGE_ENABLED'] == 'true'
    return unless message.incoming? && message.private == false && message.inbox.channel_type == 'Channel::WebWidget'
    return unless message.account_id == message.conversation.account_id && message.inbox.account_id == message.account_id

    # The database assigns display_id during conversation INSERT. A freshly
    # created ActiveRecord object can still have nil until reloaded, including
    # the first message saved inside the widget's creation transaction. Read
    # the persisted account-scoped number in this SAME transaction; never emit
    # an empty callback ID or substitute the internal conversation primary key.
    display_id = Conversation.where(id: message.conversation_id, account_id: message.account_id).pick(:display_id)
    raise 'reception_conversation_number_unavailable' unless display_id.is_a?(Integer) && display_id.positive?

    create!(message_id: message.id, payload: {
      event: 'message_created', id: message.id.to_s, message_type: 0, private: false,
      account: { id: message.account_id.to_s }, inbox: { id: message.inbox_id.to_s },
      # Chatwoot account-scoped REST URLs use display_id, NOT the internal primary key.
      conversation: { id: display_id.to_s, inbox_id: message.inbox_id.to_s }
    })
  end

  def self.configuration
    file = ENV['CHATWOOT_CALLBACK_SECRET_FILE'].to_s
    secret = file.empty? ? ENV['CHATWOOT_CALLBACK_SECRET'].to_s : File.binread(file, 65_537).sub(/\r?\n\z/, '')
    raise 'invalid_reception_secret' unless secret.bytesize.between?(32, 65_536)
    uri = URI.parse(ENV.fetch('REPLYNEST_RECEPTION_BRIDGE_URL', 'http://channel-gateway:3001/webhooks/chatwoot/reception'))
    # Fixed internal destination: no user-controlled URL, redirects or external plaintext HTTP.
    raise 'invalid_reception_destination' unless uri.to_s == 'http://channel-gateway:3001/webhooks/chatwoot/reception'
    [uri, secret]
  end

  def self.deliver(payload)
    uri, secret = configuration
    body = JSON.generate(payload)
    timestamp = Time.now.to_i.to_s
    request = Net::HTTP::Post.new(uri.request_uri)
    request['Content-Type'] = 'application/json'
    request['x-replynest-chatwoot-timestamp'] = timestamp
    request['x-replynest-chatwoot-signature'] = 'v1=' + OpenSSL::HMAC.hexdigest('SHA256', secret, timestamp + '.' + body)
    request.body = body
    http = Net::HTTP.new(uri.host, uri.port, nil)
    http.open_timeout = 3
    http.read_timeout = 8
    http.write_timeout = 5
    response = http.request(request)
    # At-least-once delivery: gateway persists/deduplicates before acknowledging.
    raise 'reception_bridge_not_acknowledged' unless response.code == '200'
  end

  def self.process_one(transport: method(:deliver))
    return false unless ENV['REPLYNEST_RECEPTION_BRIDGE_ENABLED'] == 'true'
    token = SecureRandom.uuid
    row = transaction do
      stale = where(state: 'processing').where('locked_at < ?', 2.minutes.ago).order(:locked_at).limit(100).lock('FOR UPDATE SKIP LOCKED')
      stale.each { |r| r.update!(state: r.attempts >= 12 ? 'failed' : 'pending', available_at: Time.current, reason: 'interrupted') }
      candidate = where(state: 'pending').where('available_at <= ?', Time.current).order(:available_at, :id).lock('FOR UPDATE SKIP LOCKED').first
      candidate&.update!(state: 'processing', attempts: candidate.attempts + 1, locked_at: Time.current, worker_token: token)
      candidate
    end
    return false unless row
    begin
      transport.call(row.payload)
      where(id: row.id, state: 'processing', worker_token: token).update_all(state: 'delivered', reason: nil, updated_at: Time.current)
    rescue StandardError
      where(id: row.id, state: 'processing', worker_token: token).update_all(
        state: row.attempts >= 12 ? 'failed' : 'pending', reason: 'delivery_unacknowledged',
        available_at: Time.current + [300, 5 * row.attempts**2].min.seconds, updated_at: Time.current
      )
    end
    true
  end

  def self.backlog
    # Bounded signal, not an exact count over all history. 1001 means "over 1000".
    pending = where(state: 'pending')
    oldest = pending.order(:available_at, :id).pick(:available_at)
    { pending_capped: pending.limit(1001).count,
      overdue_seconds: oldest ? [0, (Time.current - oldest).to_i].max : 0 }
  end
end
