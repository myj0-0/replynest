# Run with bundle exec rails runner script/replynest_reception_bridge.rb.
abort 'reception_bridge_disabled' unless ENV['REPLYNEST_RECEPTION_BRIDGE_ENABLED'] == 'true'
ReplynestReceptionOutbox.configuration
stopping = false
last_report = 0
%w[TERM INT].each { |signal| Signal.trap(signal) { stopping = true } }
until stopping
  begin
    20.times do
      break if stopping || !ReplynestReceptionOutbox.process_one
    end
    if Process.clock_gettime(Process::CLOCK_MONOTONIC) - last_report >= 60
      puts JSON.generate({ event: 'reception_bridge_backlog' }.merge(ReplynestReceptionOutbox.backlog))
      last_report = Process.clock_gettime(Process::CLOCK_MONOTONIC)
    end
  rescue StandardError
    warn 'reception_bridge_poll_unavailable' # Do not log payloads or secrets.
  end
  sleep 1 unless stopping
end
