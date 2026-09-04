# version and sha256 are rewritten by .github/workflows/release.yml on each signed release.
# Don't hand-edit them: a version bumped ahead of a published release makes the URL resolve
# while the checksum still points at the previous build, which fails only after a 120MB download.
cask "wisp" do
  version "0.1.15"
  sha256 "e3fd3095d148acd578f43ca01257668e79f07b363dd28b4114d3b22d5758fb49"

  url "https://github.com/oglimmer/wisp/releases/download/v#{version}/Wisp-#{version}-arm64.dmg",
      verified: "github.com/oglimmer/wisp/"
  name "Wisp"
  desc "Minimal Markdown note editor with a folder tree and Claude-powered filing"
  homepage "https://github.com/oglimmer/wisp"

  livecheck do
    url :url
    strategy :github_latest
  end

  depends_on arch: :arm64
  depends_on macos: :monterey

  app "Wisp.app"

  zap trash: [
    "~/Library/Application Support/Wisp",
    "~/Library/Logs/Wisp",
    "~/Library/Preferences/com.oglimmer.wisp.plist",
    "~/Library/Saved Application State/com.oglimmer.wisp.savedState",
  ]
end
