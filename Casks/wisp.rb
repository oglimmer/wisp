# version and sha256 are rewritten by .github/workflows/release.yml on each signed release.
# Don't hand-edit them: a version bumped ahead of a published release makes the URL resolve
# while the checksum still points at the previous build, which fails only after a 120MB download.
cask "wisp" do
  version "0.1.14"
  sha256 "20ea2e217006abe0687819f1a13eabb492cf9438eb86c613093a834e4dbe1314"

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
  depends_on macos: ">= :monterey"

  app "Wisp.app"

  zap trash: [
    "~/Library/Application Support/Wisp",
    "~/Library/Logs/Wisp",
    "~/Library/Preferences/com.oglimmer.wisp.plist",
    "~/Library/Saved Application State/com.oglimmer.wisp.savedState",
  ]
end
