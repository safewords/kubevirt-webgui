// Shown before the app mounts, and instead of it if it cannot start — so a
// failed module load or an unreachable server is a message, not a blank page.
(function () {
  var started = Date.now()
  var errors = []

  function render(title, detail) {
    var app = document.getElementById('app')
    if (!app || app.getAttribute('data-mounted')) return
    var box = document.getElementById('boot-status')
    if (!box) return
    box.querySelector('[data-title]').textContent = title
    box.querySelector('[data-detail]').textContent = detail || ''
  }

  window.addEventListener('error', function (event) {
    errors.push(event.message || String(event.error || 'script error'))
    render('The interface failed to start', errors.join('\n'))
  })
  window.addEventListener('unhandledrejection', function (event) {
    var reason = event.reason && (event.reason.message || event.reason)
    errors.push(String(reason))
    render('The interface failed to start', errors.join('\n'))
  })

  setTimeout(function () {
    if (errors.length) return
    render('Still starting…', 'This is taking longer than expected (' + Math.round((Date.now() - started) / 1000) + 's). Reload the page if it does not appear, and check the browser console.')
  }, 12000)
})()
