package main

func shortDecl(a int, b int) int {
	x := a + b
	y := x * 2
	x = y - 1
	return x + y
}
