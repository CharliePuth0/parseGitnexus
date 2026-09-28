package main

func switchExpr(kind int) string {
	name := "other"
	switch kind {
	case 1:
		name = "one"
	case 2:
		name = "two"
	default:
		name = "many"
	}
	return name
}
