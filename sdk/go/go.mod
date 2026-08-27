// Nested module inside the wapi monorepo. Go resolves subdirectory modules natively, so
// `go get github.com/crafter-station/wapi/sdk/go` works without the vendoring the TypeScript
// client needs — see sdk/README.md.
module github.com/crafter-station/wapi/sdk/go

go 1.22
