// The Git plugin refuses `file://` remotes ("references a local directory, which may be insecure").
// Here the controller is single-user localhost and the "remote" IS the developer's own working
// repo — feat/go-server is local-only and has never been pushed, so there is no origin URL to
// build from.
//
// ⚠️ Setting the SYSTEM PROPERTY alone does not work. GitSCM reads it into a static field at
// class-load time, which happens before init.groovy.d runs, so the property is applied too late
// and checkouts keep failing. Assign the field directly.
//
// Revisit once the branch is pushed (point REPO_URL at origin) or if Jenkins stops being
// single-user-localhost.
System.setProperty("hudson.plugins.git.GitSCM.ALLOW_LOCAL_CHECKOUT", "true")
try {
  hudson.plugins.git.GitSCM.ALLOW_LOCAL_CHECKOUT = true
  println("chessalive-ci: GitSCM.ALLOW_LOCAL_CHECKOUT field = " + hudson.plugins.git.GitSCM.ALLOW_LOCAL_CHECKOUT)
} catch (Throwable t) {
  println("chessalive-ci: could not set ALLOW_LOCAL_CHECKOUT field: " + t)
}
