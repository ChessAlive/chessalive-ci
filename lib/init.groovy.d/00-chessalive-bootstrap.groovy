// Non-interactive Jenkins bootstrap (replaces the setup wizard).
// Created by chessalive-ci. Safe to delete once Jenkins is configured.
import jenkins.model.*
import hudson.security.*
import jenkins.install.InstallState

def jenkins = Jenkins.get()

// Local account database with a single admin. Anonymous read is OFF: even on a loopback-only
// port, an unauthenticated Jenkins is a remote-code-execution surface for anything else running
// on this machine (including a browser page hitting 127.0.0.1).
if (!(jenkins.getSecurityRealm() instanceof HudsonPrivateSecurityRealm)) {
  def realm = new HudsonPrivateSecurityRealm(false)
  realm.createAccount("admin", "__CHESSALIVE_ADMIN_PASSWORD__")
  jenkins.setSecurityRealm(realm)

  def strategy = new FullControlOnceLoggedInAuthorizationStrategy()
  strategy.setAllowAnonymousRead(false)
  jenkins.setAuthorizationStrategy(strategy)
}

// Mark setup complete so Jenkins does not re-present the unlock wizard.
if (!jenkins.installState.isSetupComplete()) {
  InstallState.INITIAL_SETUP_COMPLETED.initializeState()
}

jenkins.save()
