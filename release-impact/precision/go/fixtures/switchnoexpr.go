package main

func switchNoExpr(n int) string {
	tag := "zero"
	switch {
	case n > 10:
		tag = "big"
	case n > 0:
		tag = "small"
	}
	return tag
}
