package main

func forBreak(n int) int {
	i := 0
	for i < n {
		if i == 3 {
			break
		}
		i = i + 1
	}
	return i
}
