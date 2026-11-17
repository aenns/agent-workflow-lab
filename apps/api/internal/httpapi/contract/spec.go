package contract

import _ "embed"

//go:generate go run github.com/oapi-codegen/oapi-codegen/v2/cmd/oapi-codegen@v2.8.1 -config oapi-codegen.yaml openapi.yaml

//go:embed openapi.yaml
var spec string

func Document() string { return spec }
